/**
 * GroupChatsGroupClient — an ISOLATED NDK instance dedicated to NIP-29 group relays.
 *
 * ARCHITECTURE EXCEPTION (user-approved): the project rule is "never import NDK directly, go
 * through NostrTransport". Here we deliberately spin up a second, self-contained NDK instance
 * that ONLY ever knows the group relays declared in the user's kind:10009. This keeps the NIP-42
 * relay AUTH strictly scoped: authenticating (which reveals the user's npub to a relay) happens
 * ONLY against NIP-29 group relays that already know the user as a member — it can never leak
 * onto the user's normal app relays managed by NostrTransport. That isolation is the whole point.
 *
 * The instance carries no cache adapter and no persistent relays: it is transient infrastructure,
 * created on first poll and torn down on addon destroy / account switch.
 */

import NDK, { NDKEvent, NDKSubscriptionCacheUsage } from '@nostr-dev-kit/ndk';
import type { NDKFilter, NDKRelay, NDKSubscription } from '@nostr-dev-kit/ndk';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { AuthService } from '../../services/AuthService';
import { diagLog } from '../../services/DiagnosticLogger';

/** NIP-29 activity we treat as "someone wrote something". */
const ACTIVITY_KINDS = [9, 11, 1111]; // 9 chat message, 11 forum thread root, 1111 NIP-22 reply
const GROUP_METADATA_KIND = 39000;
const NIP42_AUTH_KIND = 22242;
// Group relays (e.g. groups.0xchat.com) are slow to reach EOSE behind NIP-42 AUTH; give them room.
const FETCH_TIMEOUT_MS = 12000;

export class GroupChatsGroupClient {
  private ndk: NDK | null = null;
  private connectedRelays = new Set<string>();
  private destroyed = false;

  /**
   * Lazily build the isolated NDK instance and make sure every requested relay is connected.
   * The relay AUTH policy signs a kind:22242 event through AuthService (the only authorized
   * signing path) so private/closed groups become readable; public groups never trigger it.
   */
  private async ensure(relays: string[]): Promise<NDK | null> {
    if (this.destroyed) return null;

    if (!this.ndk) {
      this.ndk = new NDK({
        explicitRelayUrls: [],
        enableOutboxModel: false,
        autoConnectUserRelays: false,
      });
      // Scoped NIP-42: only ever runs for the group relays this instance connects to.
      this.ndk.relayAuthDefaultPolicy = (relay: NDKRelay, challenge: string) =>
        this.signAuth(relay, challenge);
    }

    const fresh = relays.filter(url => !this.connectedRelays.has(url));
    for (const url of fresh) {
      this.ndk.addExplicitRelay(url, undefined, true);
      this.connectedRelays.add(url);
    }
    try {
      await this.ndk.connect(2000);
    } catch {
      // Individual relays may still connect after this; fetch will time out gracefully.
    }
    return this.destroyed ? null : this.ndk;
  }

  /** Build + sign the NIP-42 AUTH event. Returns the NDKEvent NDK expects, or false to skip. */
  private async signAuth(relay: NDKRelay, challenge: string): Promise<NDKEvent | false> {
    const auth = AuthService.getInstance();
    const pubkey = auth.getCurrentUser()?.pubkey;
    if (!pubkey || !this.ndk) return false;
    try {
      const draft = {
        kind: NIP42_AUTH_KIND,
        created_at: Math.floor(Date.now() / 1000),
        content: '',
        tags: [['relay', relay.url], ['challenge', challenge]],
        pubkey,
      };
      const signed = await auth.signEvent(draft) as NostrEvent;
      diagLog('addons', 'group-chats: signed relay AUTH', { relay: relay.url });
      return new NDKEvent(this.ndk, signed);
    } catch (error) {
      diagLog('addons', 'group-chats: relay AUTH failed', { relay: relay.url, error: String(error) });
      return false;
    }
  }

  private async race<T>(promise: Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), FETCH_TIMEOUT_MS); });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /**
   * Fetch group activity (kinds 9/11/1111) for the given group ids on ONE relay since `since`.
   * Returns raw events; the caller filters out its own posts and applies the per-group anchor.
   *
   * We stream into a buffer and resolve on EOSE OR timeout, keeping whatever was collected either
   * way. A slow/never-EOSE group relay therefore still yields the posts it already delivered,
   * instead of the old Promise.race that discarded the entire set on timeout — which, combined
   * with the caller's anchor advance, silently swallowed unread posts forever.
   */
  public async fetchActivity(relayUrl: string, groupIds: string[], since: number): Promise<NostrEvent[]> {
    const ndk = await this.ensure([relayUrl]);
    if (!ndk || groupIds.length === 0) return [];
    const filter: NDKFilter = { kinds: ACTIVITY_KINDS, '#h': groupIds, since } as NDKFilter;

    return await new Promise<NostrEvent[]>((resolve) => {
      const buffer = new Map<string, NostrEvent>(); // dedup across relays/dups by event id
      let settled = false;
      let sub: NDKSubscription | null = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { sub?.stop(); } catch { /* best-effort teardown */ }
        resolve(Array.from(buffer.values()));
      };

      const timer = setTimeout(finish, FETCH_TIMEOUT_MS);

      try {
        sub = ndk.subscribe(
          filter,
          {
            relayUrls: [relayUrl],
            closeOnEose: true,
            groupable: false,
            cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
            onEvent: (ev: NDKEvent) => {
              const raw = ev.rawEvent();
              if (raw?.id) buffer.set(raw.id, raw);
            },
            onEose: finish,
          }
        );
      } catch (error) {
        diagLog('addons', 'group-chats: activity fetch failed', { relay: relayUrl, error: String(error) });
        finish();
      }
    });
  }

  /** Resolve display names for groups from their kind:39000 metadata. Returns groupId -> name. */
  public async fetchGroupNames(relayUrl: string, groupIds: string[]): Promise<Record<string, string>> {
    const ndk = await this.ensure([relayUrl]);
    if (!ndk || groupIds.length === 0) return {};
    const filter: NDKFilter = { kinds: [GROUP_METADATA_KIND], '#d': groupIds } as NDKFilter;
    const names: Record<string, string> = {};
    try {
      const set = await this.race(
        ndk.fetchEvents(filter, {
          relayUrls: [relayUrl],
          closeOnEose: true,
          groupable: false,
          cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
        }),
        new Set<NDKEvent>()
      );
      for (const ev of set) {
        const raw = ev.rawEvent();
        const id = raw.tags.find(t => t[0] === 'd')?.[1];
        const name = raw.tags.find(t => t[0] === 'name')?.[1];
        if (id && name) names[id] = name;
      }
    } catch (error) {
      diagLog('addons', 'group-chats: metadata fetch failed', { relay: relayUrl, error: String(error) });
    }
    return names;
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.ndk) {
      try {
        this.ndk.pool.relays.forEach(relay => relay.disconnect());
      } catch {
        // best-effort teardown
      }
      this.ndk = null;
    }
    this.connectedRelays.clear();
  }
}
