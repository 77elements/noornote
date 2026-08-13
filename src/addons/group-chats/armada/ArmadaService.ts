/**
 * ArmadaService
 *
 * Polls the Concord encrypted communities the user tracks (their
 * ArmadaCommunityRegistry) and raises ONE in-app notification per community
 * that saw new gift-wrapped activity within a poll window.
 *
 * Architecture (verified against live Armada traffic, Sprint 3):
 *   - Community messages are standard NIP-59 gift wraps (kind 1059) addressed
 *     to each member's pubkey via `#p` tag.
 *   - Unwrapping uses AuthService.nip44Decrypt (same pipeline as DMService) —
 *     NOT the community shared key (that key is only for bundle metadata).
 *   - Wraps are fetched from the community's bootstrap relays using
 *     `#p: [userPubkey]` + `since: lastAnchor`.
 *
 * Dedup: the same wrap may appear on multiple bootstrap relays (they share
 * stock relays). A per-tick Set of event IDs prevents double-counting.
 *
 * Anchor discipline mirrors GroupChatsService: never advance past unread.
 * An empty/failed fetch leaves the anchor untouched so the next tick retries
 * the same window.
 *
 * Singleton with nulled static instance on destroy (addon destroy contract).
 */

import { SystemLogger } from '../../../services/SystemLogger';
import { AuthService } from '../../../services/AuthService';
import { TypedEventBus } from '../../../core/TypedEventBus';
import { PerAccountLocalStorage, StorageKeys } from '../../../services/PerAccountLocalStorage';
import { diagLog } from '../../../services/DiagnosticLogger';
import { nip44DecryptWithKey } from '../../../services/NostrToolsAdapter';
import { ArmadaCommunityRegistry } from './ArmadaCommunityRegistry';
import { channelGroupKey, controlGroupKey, type GroupKey } from './concordGroupKey';
import { ArmadaRelayClient } from './ArmadaRelayClient';
import { GROUP_CHATS_DEFAULT_INTERVAL_MS, GROUP_CHATS_INTERVAL_OPTIONS } from '../GroupChatsService';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { TrackedCommunity } from './types';

const KIND_SEAL = 13;
const INITIAL_DELAY_MS = 60 * 1000; // let login fetches settle before the first poll

export { GROUP_CHATS_INTERVAL_OPTIONS as ARMADA_INTERVAL_OPTIONS };
export { GROUP_CHATS_DEFAULT_INTERVAL_MS as ARMADA_DEFAULT_INTERVAL_MS };

export class ArmadaService {
  private static instance: ArmadaService | null = null;

  private systemLogger: SystemLogger;
  private eventBus: TypedEventBus;
  private storage: PerAccountLocalStorage;
  private authService: AuthService;
  private registry: ArmadaCommunityRegistry;
  private relayClient: ArmadaRelayClient;

  private initialTimer: number | null = null;
  private interval: number | null = null;
  private intervalMs: number;
  private running = false;
  private destroyed = false;

  private constructor() {
    this.systemLogger = SystemLogger.getInstance();
    this.eventBus = TypedEventBus.getInstance();
    this.storage = PerAccountLocalStorage.getInstance();
    this.authService = AuthService.getInstance();
    this.registry = ArmadaCommunityRegistry.getInstance();
    this.relayClient = new ArmadaRelayClient();
    this.intervalMs = this.loadInterval();
  }

  public static getInstance(): ArmadaService {
    if (!ArmadaService.instance) {
      ArmadaService.instance = new ArmadaService();
    }
    return ArmadaService.instance;
  }

  private loadInterval(): number {
    return this.storage.get<number>(StorageKeys.GROUP_CHATS_POLL_INTERVAL, GROUP_CHATS_DEFAULT_INTERVAL_MS);
  }

  /** Whether the user's own posts should also raise a notification. */
  private loadNotifyOwn(): boolean {
    return this.storage.get<boolean>(StorageKeys.GROUP_CHATS_NOTIFY_OWN_POSTS, true);
  }

  /** Change the poll cadence and restart the timer immediately. */
  public setPollingInterval(intervalMs: number): void {
    this.intervalMs = intervalMs;
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = window.setInterval(() => void this.tick(), this.intervalMs);
    }
  }

  public async start(): Promise<void> {
    if (this.initialTimer !== null || this.interval !== null) return;
    this.destroyed = false;
    this.intervalMs = this.loadInterval();

    const count = this.registry.count();
    this.systemLogger.info('Armada', count > 0
      ? `Watching ${count} tracked ${count === 1 ? 'community' : 'communities'}`
      : 'Armada enabled — add communities in settings to start tracking');
    diagLog('addons', 'armada: scheduler started', { intervalMs: this.intervalMs, communities: count });

    this.initialTimer = window.setTimeout(() => {
      this.initialTimer = null;
      void this.tick();
      this.interval = window.setInterval(() => void this.tick(), this.intervalMs);
    }, INITIAL_DELAY_MS);
  }

  /** One poll window: check every tracked community for new gift-wrap activity. */
  public async tick(): Promise<void> {
    if (this.destroyed || this.running) return;
    this.running = true;
    try {
      const me = this.authService.getCurrentUser()?.pubkey;
      if (!me) return;

      const communities = this.registry.list();
      if (communities.length === 0) return;

      const notifyOwn = this.loadNotifyOwn();
      const nowSeconds = Math.floor(Date.now() / 1000);
      const anchors = this.storage.get<Record<string, number>>(StorageKeys.ARMADA_LAST_CHECK, {}) ?? {};

      // Per-tick dedup: the same wrap may arrive from multiple relays /
      // multiple communities that share stock relays.
      const seenWrapIds = new Set<string>();

      diagLog('addons', 'armada: tick started', { communities: communities.length });

      for (const community of communities) {
        if (this.destroyed) return;

        const hadAnchor = anchors[community.naddr] !== undefined;
        const anchor = anchors[community.naddr] ?? 0;

        // First time: seed baseline, never notify for pre-existing wraps.
        if (!hadAnchor) {
          anchors[community.naddr] = nowSeconds;
          continue;
        }

        const fresh = await this.pollCommunity(community, me, anchor, notifyOwn, seenWrapIds);

        if (this.destroyed) return;

        if (fresh.count > 0) {
          this.notify(community, nowSeconds, fresh.mineOnly, fresh.count);
          diagLog('addons', 'armada: fresh activity', {
            community: community.name,
            fresh: fresh.count,
            mineOnly: fresh.mineOnly,
          });
        }

        // Advance anchor to now (we've consumed this window regardless of
        // whether there was fresh activity — the wraps were fetched and
        // processed).
        anchors[community.naddr] = nowSeconds;
      }

      // Drop anchors for communities the user has untracked.
      const live = new Set(communities.map(c => c.naddr));
      for (const id of Object.keys(anchors)) {
        if (!live.has(id)) delete anchors[id];
      }
      this.storage.set(StorageKeys.ARMADA_LAST_CHECK, anchors);
    } catch (error) {
      this.systemLogger.error('Armada', 'Could not check your communities this time');
      diagLog('addons', 'armada: tick failed', { error: String(error) });
    } finally {
      this.running = false;
    }
  }

  /**
   * Fetch + decrypt gift wraps for one community since its anchor.
   *
   * Concord V2 routing: gift wraps are authored by per-channel Stream Keys
   * (derived from the community root + channel id + epoch). We subscribe by
   * `authors: [streamPubkeys]` (NOT by `#p: [userPubkey]` — wraps are not
   * addressed to recipients, they're addressed to streams). Decryption uses
   * each channel's self-ECDH conversation key.
   *
   * Returns the count of fresh, successfully-decrypted, non-duplicate wraps.
   */
  private async pollCommunity(
    community: TrackedCommunity,
    me: string,
    anchor: number,
    notifyOwn: boolean,
    seenWrapIds: Set<string>,
  ): Promise<{ count: number; mineOnly: boolean }> {
    if (!community.communityRoot) {
      diagLog('addons', 'armada: community has no root, skipping', { community: community.name });
      return { count: 0, mineOnly: false };
    }

    // Build the list of GroupKeys to poll:
    // 1. Control plane (always — catches ALL community activity: new channels,
    //    roster updates, rekeys). Derived from communityRoot + communityId.
    // 2. Channel planes (if the bundle disclosed channel IDs).
    const groupKeys: GroupKey[] = [];
    const rootEpoch = community.rootEpoch ?? 0;

    if (community.communityId) {
      try {
        groupKeys.push(controlGroupKey(community.communityRoot, community.communityId, rootEpoch));
      } catch (error) {
        diagLog('addons', 'armada: control key derivation failed', {
          community: community.name, error: String(error),
        });
      }
    }

    for (const ch of community.channels ?? []) {
      try {
        const epoch = ch.epoch ?? rootEpoch;
        groupKeys.push(channelGroupKey(community.communityRoot, ch.id, epoch));
      } catch (error) {
        diagLog('addons', 'armada: channel key derivation failed', {
          community: community.name, channelId: ch.id.slice(0, 12), error: String(error),
        });
      }
    }

    if (groupKeys.length === 0) {
      diagLog('addons', 'armada: no derivable keys (need communityId or channels)', { community: community.name });
      return { count: 0, mineOnly: false };
    }

    const streamPubkeys = groupKeys.map(gk => gk.pk);

    // Register stream keys for NIP-42 auth (Concord relays require this)
    this.relayClient.setStreamKeys(groupKeys);

    let events: NostrEvent[] = [];
    try {
      events = await this.relayClient.fetchWraps(
        community.bootstrapRelays,
        streamPubkeys,
        anchor,
      );
    } catch (error) {
      diagLog('addons', 'armada: community fetch failed', {
        community: community.name, error: String(error),
      });
    }

    if (events.length === 0) return { count: 0, mineOnly: false };

    diagLog('addons', 'armada: wraps found', {
      community: community.name, wraps: events.length, keys: groupKeys.length,
    });

    let freshCount = 0;
    let ownCount = 0;

    for (const wrap of events) {
      const wrapId = wrap.id ?? '';
      if (!wrapId || seenWrapIds.has(wrapId)) continue;
      seenWrapIds.add(wrapId);

      const rumor = this.unwrapStreamWrap(wrap, groupKeys);
      if (!rumor) continue;

      const isOwn = rumor.pubkey === me;
      if (isOwn) ownCount++;
      if (!notifyOwn && isOwn) continue;

      freshCount++;
    }

    const mineOnly = freshCount > 0 && ownCount === freshCount;
    return { count: freshCount, mineOnly };
  }

  /**
   * Decrypt a Concord V2 stream gift wrap (kind 1059) using channel GroupKeys.
   *
   * Tries each GroupKey's convKey (self-ECDH NIP-44 conversation key) until
   * one successfully decrypts the wrap → seal → rumor chain. Both layers
   * (wrap and seal) use the SAME convKey (the stream is a single-key channel).
   *
   * Returns the rumor on success, or null if no key worked.
   */
  private unwrapStreamWrap(wrapEvent: NostrEvent, groupKeys: GroupKey[]): NostrEvent | null {
    for (const gk of groupKeys) {
      try {
        // Step 1: Decrypt wrap content → seal (kind 13)
        const sealJson = nip44DecryptWithKey(wrapEvent.content, gk.convKey);
        const seal = JSON.parse(sealJson) as NostrEvent;
        if (seal.kind !== KIND_SEAL) continue;

        // Step 2: Decrypt seal content → rumor (unsigned, any kind)
        const rumorJson = nip44DecryptWithKey(seal.content, gk.convKey);
        const rumor = JSON.parse(rumorJson) as NostrEvent;

        // Anti-spoofing: rumor.pubkey === seal.pubkey
        if (rumor.pubkey !== seal.pubkey) continue;

        return rumor;
      } catch {
        // Wrong key or corrupt content — try next GroupKey
      }
    }
    return null;
  }

  /** Emit one in-app notification for a community that saw activity. */
  private notify(community: TrackedCommunity, nowSeconds: number, mine: boolean, count: number): void {
    const event: NostrEvent = {
      id: `armada-${community.naddr}-${nowSeconds}`,
      pubkey: '',
      kind: 9,
      created_at: nowSeconds,
      tags: [['h', community.naddr]],
      content: community.name,
      sig: '',
    };
    diagLog('addons', 'armada: community activity notification', {
      community: community.name,
      count,
      mine,
    });
    this.eventBus.emit('armada-notification:new', {
      event,
      groupName: community.name,
      mine,
      naddr: community.naddr,
      count,
    });
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.initialTimer !== null) { clearTimeout(this.initialTimer); this.initialTimer = null; }
    if (this.interval !== null) { clearInterval(this.interval); this.interval = null; }
    this.relayClient.destroy();
    ArmadaService.instance = null;
  }
}
