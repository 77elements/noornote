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
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../../services/PerAccountLocalStorage';
import { diagLog } from '../../../services/DiagnosticLogger';
import { nip44DecryptWithKey } from '../../../services/NostrToolsAdapter';
import { ArmadaCommunityRegistry } from './ArmadaCommunityRegistry';
import { channelGroupKey, type GroupKey } from './concordGroupKey';
import { ArmadaRelayClient } from './ArmadaRelayClient';
import {
  GROUP_CHATS_DEFAULT_INTERVAL_MS,
  GROUP_CHATS_INTERVAL_OPTIONS,
} from '../GroupChatsService';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { TrackedCommunity } from './types';

const INITIAL_DELAY_MS = 60 * 1000; // let login fetches settle before the first poll
const KIND_SEAL_ENCRYPTED = 20013;
const KIND_SEAL_PLAINTEXT = 20014;
/** Rumor kinds that count as "someone wrote something" — mirrors Nostrord (9/11/1111). */
const MESSAGE_KINDS = new Set<number>([9, 1111]);

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
    return this.storage.get<number>(
      StorageKeys.GROUP_CHATS_POLL_INTERVAL,
      GROUP_CHATS_DEFAULT_INTERVAL_MS
    );
  }

  /** Whether the user's own posts should also raise a notification. */
  private loadNotifyOwn(): boolean {
    return this.storage.get<boolean>(
      StorageKeys.GROUP_CHATS_NOTIFY_OWN_POSTS,
      true
    );
  }

  /** Change the poll cadence and restart the timer immediately. */
  public setPollingInterval(intervalMs: number): void {
    this.intervalMs = intervalMs;
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = window.setInterval(
        () => void this.tick(),
        this.intervalMs
      );
    }
  }

  public async start(): Promise<void> {
    if (this.initialTimer !== null || this.interval !== null) return;
    this.destroyed = false;
    this.intervalMs = this.loadInterval();

    const count = this.registry.count();
    this.systemLogger.info(
      'Armada',
      count > 0
        ? `Watching ${count} tracked ${count === 1 ? 'community' : 'communities'}`
        : 'Armada enabled — add communities in settings to start tracking'
    );
    diagLog('addons', 'armada: scheduler started', {
      intervalMs: this.intervalMs,
      communities: count,
    });

    this.initialTimer = window.setTimeout(() => {
      this.initialTimer = null;
      void this.tick();
      this.interval = window.setInterval(
        () => void this.tick(),
        this.intervalMs
      );
    }, INITIAL_DELAY_MS);
  }

  /** One poll window: check every tracked community for new gift-wrap activity. */
  public async tick(): Promise<void> {
    if (this.destroyed || this.running) {
      diagLog('addons', 'armada: tick skipped', {
        destroyed: this.destroyed,
        running: this.running,
      });
      return;
    }
    this.running = true;
    try {
      const me = this.authService.getCurrentUser()?.pubkey;
      if (!me) return;

      const communities = this.registry.list();
      if (communities.length === 0) return;

      const notifyOwn = this.loadNotifyOwn();
      const nowSeconds = Math.floor(Date.now() / 1000);
      const anchors =
        this.storage.get<Record<string, number>>(
          StorageKeys.ARMADA_LAST_CHECK,
          {}
        ) ?? {};

      // Per-tick dedup: the same wrap may arrive from multiple relays /
      // multiple communities that share stock relays.
      const seenWrapIds = new Set<string>();

      diagLog('addons', 'armada: tick started', {
        communities: communities.length,
      });

      for (const community of communities) {
        if (this.destroyed) return;

        const hadAnchor = anchors[community.naddr] !== undefined;
        const anchor = anchors[community.naddr] ?? 0;

        // First time: seed baseline, never notify for pre-existing wraps.
        if (!hadAnchor) {
          anchors[community.naddr] = nowSeconds;
          continue;
        }

        const fresh = await this.pollCommunity(
          community,
          me,
          anchor,
          notifyOwn,
          seenWrapIds
        );

        if (this.destroyed) return;

        if (fresh.count > 0) {
          this.notify(community, nowSeconds, fresh.mineOnly, fresh.count);
          this.systemLogger.info(
            'Armada',
            `${fresh.count} new in "${community.name}"`
          );
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
      this.systemLogger.error(
        'Armada',
        'Could not check your communities this time'
      );
      diagLog('addons', 'armada: tick failed', { error: String(error) });
    } finally {
      this.running = false;
    }
  }

  /**
   * Fetch + decrypt gift wraps for one community since its anchor.
   *
   * Polls only the CHANNEL stream addresses (derived from communityRoot +
   * channelId per CORD-03). The control plane is NOT polled: its wraps are
   * config events (roster/metadata editions, kind 3308) which must not
   * raise notifications.
   *
   * Each fetched wrap is decrypted (wrap → seal 20013/20014 → rumor) and
   * only MESSAGE-kind rumors (9 chat / 1111 thread-reply — the Concord
   * pendant of Nostrord's 9/11/1111) count toward the notification.
   * Reactions (7), edits, deletes, and control editions fall silent —
   * including reactions on OLD posts, which are new wraps but kind-7 rumors.
   *
   * Own-post filtering works again with decryption: the rumor's pubkey is
   * the real author, so the shared "Notify me about my own posts" toggle
   * applies exactly as it does for Nostrord.
   */
  private async pollCommunity(
    community: TrackedCommunity,
    me: string,
    anchor: number,
    notifyOwn: boolean,
    seenWrapIds: Set<string>
  ): Promise<{ count: number; mineOnly: boolean }> {
    // Channel stream pubkeys — derived from communityRoot + channelId.
    const groupKeys: GroupKey[] = [];
    if (community.communityRoot && community.channels) {
      const rootEpoch = community.rootEpoch ?? 0;
      for (const ch of community.channels) {
        try {
          groupKeys.push(
            channelGroupKey(
              community.communityRoot,
              ch.id,
              ch.epoch ?? rootEpoch
            )
          );
        } catch {
          /* derivation failed for this channel — skip */
        }
      }
    }

    if (groupKeys.length === 0) {
      diagLog('addons', 'armada: no channels to poll', {
        community: community.name,
      });
      return { count: 0, mineOnly: false };
    }

    const authors = groupKeys.map(gk => gk.pk);

    // Fetch wraps by the channel stream addresses
    this.relayClient.setStreamKeys(groupKeys); // for NIP-42 auth if needed
    let events: NostrEvent[] = [];
    try {
      events = await this.relayClient.fetchWraps(
        community.bootstrapRelays,
        authors,
        anchor
      );
    } catch (error) {
      diagLog('addons', 'armada: fetch failed', {
        community: community.name,
        error: String(error),
      });
    }

    if (events.length === 0) return { count: 0, mineOnly: false };

    diagLog('addons', 'armada: wraps found', {
      community: community.name,
      wraps: events.length,
      channels: groupKeys.length,
    });

    // Decrypt each wrap and count only message-kind rumors.
    let freshCount = 0;
    let ownCount = 0;
    for (const wrap of events) {
      const wrapId = wrap.id ?? '';
      if (!wrapId || seenWrapIds.has(wrapId)) continue;
      seenWrapIds.add(wrapId);

      const rumor = this.unwrapStreamWrap(wrap, groupKeys);
      if (!rumor) continue; // wrong key or malformed — not ours to count
      if (rumor.kind === undefined || !MESSAGE_KINDS.has(rumor.kind)) continue; // reaction/edit/delete → silent

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
   * one successfully decrypts the wrap → seal → rumor chain.
   *
   * Seal forms (CORD-01/02): 20013 (encrypted — the rumor is NIP-44-encrypted
   * again with the same convKey) or 20014 (plaintext — the seal's content IS
   * the rumor JSON, byte-verbatim; control-plane compaction form).
   */
  private unwrapStreamWrap(
    wrapEvent: NostrEvent,
    groupKeys: GroupKey[]
  ): NostrEvent | null {
    for (const gk of groupKeys) {
      try {
        const sealJson = nip44DecryptWithKey(wrapEvent.content, gk.convKey);
        const seal = JSON.parse(sealJson) as NostrEvent;
        if (
          seal.kind !== KIND_SEAL_ENCRYPTED &&
          seal.kind !== KIND_SEAL_PLAINTEXT
        )
          continue;

        let rumor: NostrEvent;
        if (seal.kind === KIND_SEAL_ENCRYPTED) {
          rumor = JSON.parse(
            nip44DecryptWithKey(seal.content, gk.convKey)
          ) as NostrEvent;
        } else {
          rumor = JSON.parse(seal.content) as NostrEvent;
        }

        // Anti-spoofing: rumor.pubkey === seal.pubkey (CORD-01)
        if (rumor.pubkey !== seal.pubkey) continue;

        return rumor;
      } catch {
        // Wrong key or corrupt content — try next GroupKey
      }
    }
    return null;
  }

  /** Emit one in-app notification for a community that saw activity. */
  private notify(
    community: TrackedCommunity,
    nowSeconds: number,
    mine: boolean,
    count: number
  ): void {
    const event: NostrEvent = {
      id: `armada-${community.naddr}-${nowSeconds}`,
      pubkey: '',
      kind: 9,
      created_at: nowSeconds,
      tags: [['h', community.naddr]],
      content: community.name,
      sig: '',
    };
    // Click-through target: the armada.buzz group page, not the invite link
    // (invites expire / get revoked; the community page is stable).
    // Built from communityId + the first tracked channel id.
    let communityUrl: string | undefined;
    const firstChannel = community.channels?.[0];
    if (community.communityId && firstChannel) {
      communityUrl = `https://armada.buzz/c/${community.communityId}/${firstChannel.id}`;
    }
    diagLog('addons', 'armada: community activity notification', {
      community: community.name,
      count,
      mine,
    });
    this.eventBus.emit('armada-notification:new', {
      event,
      groupName: community.name,
      mine,
      ...(communityUrl ? { communityUrl } : {}),
      count,
    });
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.initialTimer !== null) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.relayClient.destroy();
    ArmadaService.instance = null;
  }
}
