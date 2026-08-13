/**
 * ArmadaRelayClient — an ISOLATED NDK instance for Concord V2 community relays.
 *
 * Concord relays gate kind 1059 behind NIP-42: every `authors` entry in a
 * kind-1059 REQ must be an authenticated pubkey on the connection. Stream
 * addresses (derived GroupKey pubkeys) are NOT the user's identity — so the
 * user's NIP-42 auth alone can't satisfy the relay. This client holds the
 * stream SECRET keys (derived from the community root) and signs NIP-42
 * challenges AS each stream, in addition to the user's own auth.
 *
 * Architecture mirrors GroupChatsGroupClient (isolated NDK, scoped relays),
 * but the auth policy signs MULTIPLE keys per challenge (user + streams).
 *
 * Ported concepts from Armada's streamAuth.ts + NostrProvider.tsx.
 */

import NDK, { NDKEvent, NDKSubscriptionCacheUsage } from '@nostr-dev-kit/ndk';
import type { NDKFilter, NDKRelay, NDKSubscription } from '@nostr-dev-kit/ndk';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { finalizeEvent } from 'nostr-tools/pure';
import { AuthService } from '../../../services/AuthService';
import { diagLog } from '../../../services/DiagnosticLogger';
import type { GroupKey } from './concordGroupKey';

const KIND_AUTH = 22242;
const FETCH_TIMEOUT_MS = 15000;

export class ArmadaRelayClient {
  private ndk: NDK | null = null;
  private connectedRelays = new Set<string>();
  private streamKeys: GroupKey[] = [];
  private authService: AuthService;
  private destroyed = false;

  constructor() {
    this.authService = AuthService.getInstance();
  }

  /**
   * Register the stream keys to authenticate as. Must be called before fetch
   * so the auth policy knows which keys to sign challenges with.
   */
  public setStreamKeys(keys: GroupKey[]): void {
    this.streamKeys = keys;
  }

  private async ensure(relays: string[]): Promise<NDK | null> {
    if (this.destroyed) return null;

    if (!this.ndk) {
      this.ndk = new NDK({
        explicitRelayUrls: [],
        enableOutboxModel: false,
        autoConnectUserRelays: false,
      });
      this.ndk.relayAuthDefaultPolicy = (relay: NDKRelay, challenge: string) =>
        this.signAuth(relay, challenge);
    }

    const fresh = relays.filter(url => !this.connectedRelays.has(url));
    for (const url of fresh) {
      this.ndk.addExplicitRelay(url, undefined, true);
      this.connectedRelays.add(url);
    }
    try {
      await this.ndk.connect(3000);
    } catch {
      // Individual relays may still connect after this.
    }
    return this.destroyed ? null : this.ndk;
  }

  /**
   * NIP-42 auth handler — signs the challenge as BOTH the user AND every
   * registered stream key. The user auth is returned (so NDK's own auth
   * tracking works); stream auths are sent as extra AUTH frames on the
   * same socket (ditto-relay keeps a per-connection set of authenticated
   * pubkeys and accepts multiple AUTH events on a live connection).
   */
  private async signAuth(relay: NDKRelay, challenge: string): Promise<NDKEvent | false> {
    const pubkey = this.authService.getCurrentUser()?.pubkey;
    let userAuth: NDKEvent | false = false;

    // 1. User auth (returned for NDK's own auth tracking)
    if (pubkey) {
      try {
        const draft = {
          kind: KIND_AUTH,
          created_at: Math.floor(Date.now() / 1000),
          content: '',
          tags: [['relay', relay.url], ['challenge', challenge]],
          pubkey,
        };
        const signed = await this.authService.signEvent(draft) as NostrEvent;
        userAuth = new NDKEvent(this.ndk!, signed);
      } catch {
        // User auth failed — continue with stream auth only
      }
    }

    // 2. Stream key auths (sent as extra AUTH frames on the same socket)
    for (const gk of this.streamKeys) {
      try {
        const draft = {
          kind: KIND_AUTH,
          created_at: Math.floor(Date.now() / 1000),
          content: '',
          tags: [['relay', relay.url], ['challenge', challenge]],
          pubkey: gk.pk,
        };
        const signed = finalizeEvent(draft, gk.sk) as NostrEvent;
        // NDK's relayAuthDefaultPolicy only sends ONE auth event (the one we
        // return). For additional stream-key auths, we send them directly on
        // the relay's WebSocket — ditto-relay accepts multiple AUTH frames on
        // a live connection (per Armada's streamAuth.ts).
        const frame = JSON.stringify(['AUTH', signed]);
        // Access the raw WebSocket through NDK's internal connectivity layer
        const conn = (relay as unknown as { connectivity?: { ws?: { send: (data: string) => void } } }).connectivity;
        conn?.ws?.send(frame);
        diagLog('addons', 'armada: stream-key AUTH sent', {
          streamPk: gk.pk.slice(0, 12),
          relay: relay.url,
        });
      } catch {
        // Stream auth failed — best-effort, continue
      }
    }

    return userAuth;
  }

  /**
   * Fetch gift wraps by stream-key authors from community relays. Handles
   * NIP-42 auth automatically (the relayAuthDefaultPolicy signs with both
   * user + stream keys on challenge).
   */
  public async fetchWraps(
    relayUrls: string[],
    authors: string[],
    since: number,
  ): Promise<NostrEvent[]> {
    const ndk = await this.ensure(relayUrls);
    if (!ndk || authors.length === 0) return [];

    const filter: NDKFilter = {
      kinds: [1059],
      authors,
      since,
    } as NDKFilter;

    return await new Promise<NostrEvent[]>((resolve) => {
      const buffer = new Map<string, NostrEvent>();
      let settled = false;
      let sub: NDKSubscription | null = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { sub?.stop(); } catch { /* best-effort */ }
        resolve(Array.from(buffer.values()));
      };

      const timer = setTimeout(finish, FETCH_TIMEOUT_MS);

      try {
        sub = ndk.subscribe(
          filter,
          {
            relayUrls,
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
        diagLog('addons', 'armada: stream fetch failed', { error: String(error) });
        finish();
      }
    });
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.ndk) {
      try {
        this.ndk.pool.relays.forEach(relay => relay.disconnect());
      } catch { /* best-effort */ }
      this.ndk = null;
    }
    this.connectedRelays.clear();
    this.streamKeys = [];
  }
}
