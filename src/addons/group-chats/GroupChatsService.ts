/**
 * GroupChatsService
 * Polls the NIP-29 groups the user belongs to and raises ONE in-app notification per group that
 * saw new activity within a poll window. The poll interval IS the debounce window: each tick asks
 * "was there anything since the last tick?" — 1 post or 100 posts in that window produce a single
 * notification per group. By default the user's own posts also count (own-post heads-up); this can
 * be turned off in settings.
 *
 * Group membership is read from the user's kind:10009 list (NIP-51 simple groups) on their normal
 * app relays; each group tag carries its host relay, so groups are polled per relay. Reading the
 * group events themselves (incl. private/closed groups via NIP-42 AUTH) goes through the isolated
 * GroupChatsGroupClient, never the main transport.
 *
 * Anchor discipline (the reason a slow group relay no longer swallows posts): a group's anchor is
 * only ever advanced to a timestamp we ACTUALLY read — never to "now". An empty/failed fetch on an
 * already-tracked group leaves its anchor untouched so the next tick retries the SAME window.
 *
 * Singleton with a nulled static instance on destroy so account switches return a fresh instance
 * (addon destroy contract).
 */

import { SystemLogger } from '../../services/SystemLogger';
import { AuthService } from '../../services/AuthService';
import { RelayConfig } from '../../services/RelayConfig';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { TypedEventBus } from '../../core/TypedEventBus';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';
import { diagLog } from '../../services/DiagnosticLogger';
import { GroupChatsGroupClient } from './GroupChatsGroupClient';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

interface GroupRef {
  groupId: string;
  relayUrl: string;
  /** Display name from the kind:10009 tag, if the list provided one. */
  tagName?: string;
}

/** Poll interval options offered in settings (milliseconds). 30 min is the default. */
export const GROUP_CHATS_INTERVAL_OPTIONS = [
  { value: 5 * 60 * 1000, label: 'Every 5 minutes' },
  { value: 15 * 60 * 1000, label: 'Every 15 minutes' },
  { value: 30 * 60 * 1000, label: 'Every 30 minutes' },
  { value: 60 * 60 * 1000, label: 'Every 60 minutes' },
  { value: 180 * 60 * 1000, label: 'Every 180 minutes' },
];
export const GROUP_CHATS_DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

const INITIAL_DELAY_MS = 45 * 1000; // let login fetches settle before the first poll

export class GroupChatsService {
  private static instance: GroupChatsService | null = null;

  private client: GroupChatsGroupClient;
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
    this.client = new GroupChatsGroupClient();
    this.systemLogger = SystemLogger.getInstance();
    this.eventBus = TypedEventBus.getInstance();
    this.storage = PerAccountLocalStorage.getInstance();
    this.intervalMs = this.loadInterval();
  }

  public static getInstance(): GroupChatsService {
    if (!GroupChatsService.instance) {
      GroupChatsService.instance = new GroupChatsService();
    }
    return GroupChatsService.instance;
  }

  public loadInterval(): number {
    return this.storage.get<number>(
      StorageKeys.GROUP_CHATS_POLL_INTERVAL,
      GROUP_CHATS_DEFAULT_INTERVAL_MS
    );
  }

  /** Whether the user's own posts should also raise a notification. Default: yes. */
  private loadNotifyOwn(): boolean {
    return this.storage.get<boolean>(
      StorageKeys.GROUP_CHATS_NOTIFY_OWN_POSTS,
      true
    );
  }

  /** Change the poll cadence and restart the timer immediately (no re-login needed). */
  public setPollingInterval(intervalMs: number): void {
    this.intervalMs = intervalMs;
    this.storage.set(StorageKeys.GROUP_CHATS_POLL_INTERVAL, intervalMs);
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = window.setInterval(
        () => void this.tick(),
        this.intervalMs
      );
    }
  }

  public async start(): Promise<void> {
    if (this.initialTimer !== null || this.interval !== null) return; // already running
    this.destroyed = false;
    this.intervalMs = this.loadInterval();

    this.systemLogger.info(
      'Group Chats',
      'Watching your groups for new activity'
    );
    diagLog('addons', 'group-chats: scheduler started', {
      intervalMs: this.intervalMs,
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

  /** One poll window: check every group for activity since the last tick. */
  public async tick(): Promise<void> {
    if (this.destroyed || this.running) return;
    this.running = true;
    try {
      const me = AuthService.getInstance().getCurrentUser()?.pubkey;
      if (!me) return;

      const groups = await this.loadUserGroups(me);
      diagLog('addons', 'group-chats: groups loaded', {
        groups: groups.length,
        relays: [...new Set(groups.map(g => g.relayUrl))],
      });
      if (this.destroyed || groups.length === 0) return;

      const notifyOwn = this.loadNotifyOwn();
      const nowSeconds = Math.floor(Date.now() / 1000);
      const anchors = this.storage.get<Record<string, number>>(
        StorageKeys.GROUP_CHATS_LAST_CHECK,
        {}
      );

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
        const since = Math.min(
          ...relayGroups.map(g => anchors[g.groupId] ?? nowSeconds)
        );
        const events = await this.client.fetchActivity(
          relayUrl,
          groupIds,
          since
        );
        diagLog('addons', 'group-chats: relay fetch', {
          relay: relayUrl,
          groups: groupIds.length,
          events: events.length,
          since,
        });
        await this.resolveNames(relayUrl, relayGroups, events);

        for (const g of relayGroups) {
          const hadAnchor = anchors[g.groupId] !== undefined;
          const anchor = anchors[g.groupId] ?? 0;
          const groupEvents = events.filter(
            e => e.tags.find(t => t[0] === 'h')?.[1] === g.groupId
          );
          const newestSeen = groupEvents.reduce(
            (max, e) => Math.max(max, e.created_at),
            0
          );

          // First time we ever see this group: seed the baseline and never notify for pre-existing
          // posts. Seed from the newest post we pulled, else from `now` — but ALWAYS seed (even on
          // an empty fetch) so a brand-new group starts tracking instead of staying anchorless.
          if (!hadAnchor) {
            anchors[g.groupId] = newestSeen || nowSeconds;
            continue;
          }

          // Already tracked but we pulled nothing this window (slow/failed relay read): leave the
          // anchor untouched so the next tick retries the SAME window. Never advance past unread.
          if (groupEvents.length === 0) continue;

          const fresh = groupEvents.filter(
            e => (notifyOwn || e.pubkey !== me) && e.created_at > anchor
          );

          if (fresh.length > 0) {
            const mineOnly = fresh.every(e => e.pubkey === me);
            this.notify(g, nowSeconds, mineOnly);
            diagLog('addons', 'group-chats: fresh activity', {
              groupId: g.groupId,
              fresh: fresh.length,
              mineOnly,
            });
            // Advance only to what we actually read — never to `now`.
            anchors[g.groupId] = Math.max(anchor, newestSeen);
          }
          // fresh empty (only old or own-filtered events) → anchor stays; nothing new to lose.
        }
      }

      // Drop anchors for groups the user has left, then persist.
      const live = new Set(groups.map(g => g.groupId));
      for (const id of Object.keys(anchors)) {
        if (!live.has(id)) delete anchors[id];
      }
      this.storage.set(StorageKeys.GROUP_CHATS_LAST_CHECK, anchors);
    } catch (error) {
      this.systemLogger.error(
        'Group Chats',
        'Could not check your groups this time'
      );
      diagLog('addons', 'group-chats: tick failed', { error: String(error) });
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
      'group-chats:group-list'
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
      const ref: GroupRef = {
        groupId,
        relayUrl: this.normalizeRelay(relayUrl),
      };
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
  private async resolveNames(
    relayUrl: string,
    groups: GroupRef[],
    _events: NostrEvent[]
  ): Promise<void> {
    const missing: string[] = [];
    for (const g of groups) {
      if (this.nameCache[g.groupId]) continue;
      if (g.tagName) {
        this.nameCache[g.groupId] = g.tagName;
        continue;
      }
      missing.push(g.groupId);
    }
    if (missing.length === 0) return;
    const names = await this.client.fetchGroupNames(relayUrl, missing);
    Object.assign(this.nameCache, names);
  }

  private groupName(g: GroupRef): string {
    return this.nameCache[g.groupId] || g.tagName || 'a group';
  }

  /**
   * Emit one in-app notification for a group that saw activity in this window.
   * `mine` marks a window whose fresh posts were all authored by the user (own-post heads-up),
   * so the UI can phrase it as "You posted to …" instead of "Someone posted to …".
   */
  private notify(g: GroupRef, nowSeconds: number, mine: boolean): void {
    const groupName = this.groupName(g);
    const groupRelay = g.relayUrl.replace(/^wss?:\/\//, ''); // bare host for the web-client deep link
    const event: NostrEvent = {
      id: `group-chats-${g.groupId}-${nowSeconds}`,
      pubkey: '',
      kind: 9,
      created_at: nowSeconds,
      tags: [['h', g.groupId]],
      content: groupName,
      sig: '',
    };
    diagLog('addons', 'nostrord: group activity notification', {
      groupId: g.groupId,
      mine,
    });
    this.eventBus.emit('nostrord-notification:new', {
      event,
      groupName,
      mine,
      groupRelay,
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
    this.client.destroy();
    this.nameCache = {};
    GroupChatsService.instance = null;
  }
}
