/**
 * NostrordService
 * Polls the NIP-29 groups the user belongs to and raises ONE in-app notification per group that
 * saw new activity within a poll window. The poll interval IS the debounce window: each tick asks
 * "was there anything since the last tick?" — 1 post or 100 posts in that window produce a single
 * notification per group. The user's own posts never count.
 *
 * Group membership is read from the user's kind:10009 list (NIP-51 simple groups) on their normal
 * app relays; each group tag carries its host relay, so groups are polled per relay. Reading the
 * group events themselves (incl. private/closed groups via NIP-42 AUTH) goes through the isolated
 * NostrordGroupClient, never the main transport.
 *
 * Singleton with a nulled static instance on destroy so account switches return a fresh instance
 * (addon destroy contract).
 */

import { SystemLogger } from '../../services/SystemLogger';
import { AuthService } from '../../services/AuthService';
import { RelayConfig } from '../../services/RelayConfig';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { TypedEventBus } from '../../core/TypedEventBus';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
import { diagLog } from '../../services/DiagnosticLogger';
import { NostrordGroupClient } from './NostrordGroupClient';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

interface GroupRef {
  groupId: string;
  relayUrl: string;
  /** Display name from the kind:10009 tag, if the list provided one. */
  tagName?: string;
}

/** Poll interval options offered in settings (milliseconds). 30 min is the default. */
export const NOSTRORD_INTERVAL_OPTIONS = [
  { value: 5 * 60 * 1000, label: 'Every 5 minutes' },
  { value: 15 * 60 * 1000, label: 'Every 15 minutes' },
  { value: 30 * 60 * 1000, label: 'Every 30 minutes' },
  { value: 60 * 60 * 1000, label: 'Every 60 minutes' },
  { value: 180 * 60 * 1000, label: 'Every 180 minutes' },
];
export const NOSTRORD_DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

const INITIAL_DELAY_MS = 45 * 1000; // let login fetches settle before the first poll

export class NostrordService {
  private static instance: NostrordService | null = null;

  private client: NostrordGroupClient;
  private systemLogger: SystemLogger;
  private eventBus: TypedEventBus;
  private storage: PerAccountLocalStorage;

  private initialTimer: number | null = null;
  private interval: number | null = null;
  private intervalMs: number;
  private running = false;
  private destroyed = false;

  /** In-memory cache of resolved group display names (groupId -> name). */
  private nameCache: Record<string, string> = {};

  private constructor() {
    this.client = new NostrordGroupClient();
    this.systemLogger = SystemLogger.getInstance();
    this.eventBus = TypedEventBus.getInstance();
    this.storage = PerAccountLocalStorage.getInstance();
    this.intervalMs = this.loadInterval();
  }

  public static getInstance(): NostrordService {
    if (!NostrordService.instance) {
      NostrordService.instance = new NostrordService();
    }
    return NostrordService.instance;
  }

  public loadInterval(): number {
    return this.storage.get<number>(StorageKeys.NOSTRORD_POLL_INTERVAL, NOSTRORD_DEFAULT_INTERVAL_MS);
  }

  /** Change the poll cadence and restart the timer immediately (no re-login needed). */
  public setPollingInterval(intervalMs: number): void {
    this.intervalMs = intervalMs;
    this.storage.set(StorageKeys.NOSTRORD_POLL_INTERVAL, intervalMs);
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = window.setInterval(() => void this.tick(), this.intervalMs);
    }
  }

  public async start(): Promise<void> {
    if (this.initialTimer !== null || this.interval !== null) return; // already running
    this.destroyed = false;
    this.intervalMs = this.loadInterval();

    this.systemLogger.info('Nostrord', 'Watching your groups for new activity');
    diagLog('addons', 'nostrord: scheduler started', { intervalMs: this.intervalMs });

    this.initialTimer = window.setTimeout(() => {
      this.initialTimer = null;
      void this.tick();
      this.interval = window.setInterval(() => void this.tick(), this.intervalMs);
    }, INITIAL_DELAY_MS);
  }

  /** One poll window: check every group for activity since the last tick. */
  public async tick(): Promise<void> {
    if (this.destroyed || this.running) return;
    this.running = true;
    try {
      const me = AuthService.getInstance().getCurrentUser()?.pubkey;
      if (!me) return;

      const groups = await this.loadUserGroups(me);
      if (this.destroyed || groups.length === 0) return;

      const nowSeconds = Math.floor(Date.now() / 1000);
      const anchors = this.storage.get<Record<string, number>>(StorageKeys.NOSTRORD_LAST_CHECK, {});

      // Group by relay so each relay is polled once for all its groups.
      const byRelay = new Map<string, GroupRef[]>();
      for (const g of groups) {
        const list = byRelay.get(g.relayUrl) ?? [];
        list.push(g);
        byRelay.set(g.relayUrl, list);
      }

      for (const [relayUrl, relayGroups] of byRelay) {
        if (this.destroyed) return;
        const groupIds = relayGroups.map(g => g.groupId);
        // Fetch since the oldest anchor among this relay's groups; baseline groups contribute `now`.
        const since = Math.min(...relayGroups.map(g => anchors[g.groupId] ?? nowSeconds));
        const events = await this.client.fetchActivity(relayUrl, groupIds, since);
        await this.resolveNames(relayUrl, relayGroups, events);

        for (const g of relayGroups) {
          const hadAnchor = anchors[g.groupId] !== undefined;
          const anchor = anchors[g.groupId] ?? 0;
          const fresh = events.filter(e =>
            (e.tags.find(t => t[0] === 'h')?.[1]) === g.groupId &&
            e.pubkey !== me &&
            e.created_at > anchor
          );

          if (hadAnchor && fresh.length > 0) {
            this.notify(g, nowSeconds);
          }
          // Advance the anchor every tick so the window always equals the poll interval;
          // the very first tick per group only seeds the baseline (no notification).
          anchors[g.groupId] = nowSeconds;
        }
      }

      // Drop anchors for groups the user has left, then persist.
      const live = new Set(groups.map(g => g.groupId));
      for (const id of Object.keys(anchors)) {
        if (!live.has(id)) delete anchors[id];
      }
      this.storage.set(StorageKeys.NOSTRORD_LAST_CHECK, anchors);
    } catch (error) {
      this.systemLogger.error('Nostrord', 'Could not check your groups this time');
      diagLog('addons', 'nostrord: tick failed', { error: String(error) });
    } finally {
      this.running = false;
    }
  }

  /** Read the user's kind:10009 group list from their normal read relays. */
  private async loadUserGroups(me: string): Promise<GroupRef[]> {
    const relays = RelayConfig.getInstance().getReadRelays();
    const events = await NostrTransport.getInstance().fetch(
      relays,
      [{ authors: [me], kinds: [10009 as number], limit: 1 }],
      6000,
      true,
      'nostrord:group-list'
    );
    if (events.length === 0) return [];
    // Replaceable event: newest wins.
    const latest = [...events].sort((a, b) => b.created_at - a.created_at)[0];
    if (!latest) return [];
    return this.parseGroupTags(latest);
  }

  /**
   * Parse the `group` tags of a kind:10009 event into (groupId, relayUrl) pairs.
   * Standard form is ["group", groupId, relayUrl, name?]. Some clients pack the relay into the
   * id as "host'groupId"; handle that defensively too.
   */
  private parseGroupTags(event: NostrEvent): GroupRef[] {
    const out: GroupRef[] = [];
    for (const tag of event.tags) {
      if (tag[0] !== 'group' || !tag[1]) continue;
      let groupId = tag[1];
      let relayUrl: string | undefined = tag[2];
      const tagName = tag[3];

      if (!relayUrl && groupId.includes("'")) {
        const parts = groupId.split("'");
        relayUrl = parts[0];
        groupId = parts[1] ?? groupId;
      }
      if (!relayUrl) continue; // no relay, can't poll
      const ref: GroupRef = { groupId, relayUrl: this.normalizeRelay(relayUrl) };
      if (tagName) ref.tagName = tagName;
      out.push(ref);
    }
    return out;
  }

  private normalizeRelay(url: string): string {
    let u = url.trim();
    if (!u.startsWith('ws://') && !u.startsWith('wss://')) u = `wss://${u}`;
    return u.replace(/\/+$/, '');
  }

  /** Fill the name cache from tag names and, where missing, kind:39000 metadata. */
  private async resolveNames(relayUrl: string, groups: GroupRef[], _events: NostrEvent[]): Promise<void> {
    const missing: string[] = [];
    for (const g of groups) {
      if (this.nameCache[g.groupId]) continue;
      if (g.tagName) { this.nameCache[g.groupId] = g.tagName; continue; }
      missing.push(g.groupId);
    }
    if (missing.length === 0) return;
    const names = await this.client.fetchGroupNames(relayUrl, missing);
    Object.assign(this.nameCache, names);
  }

  private groupName(g: GroupRef): string {
    return this.nameCache[g.groupId] || g.tagName || 'a group';
  }

  /** Emit one in-app notification for a group that saw activity in this window. */
  private notify(g: GroupRef, nowSeconds: number): void {
    const groupName = this.groupName(g);
    const event: NostrEvent = {
      id: `nostrord-${g.groupId}-${nowSeconds}`,
      pubkey: '',
      kind: 9,
      created_at: nowSeconds,
      tags: [['h', g.groupId]],
      content: groupName,
      sig: '',
    };
    diagLog('addons', 'nostrord: group activity notification', { groupId: g.groupId });
    this.eventBus.emit('nostrord-notification:new', { event, groupName });
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.initialTimer !== null) { clearTimeout(this.initialTimer); this.initialTimer = null; }
    if (this.interval !== null) { clearInterval(this.interval); this.interval = null; }
    this.client.destroy();
    this.nameCache = {};
    NostrordService.instance = null;
  }
}
