/**
 * NotificationsOrchestrator - Notifications Management
 * Handles mentions, reactions, reposts, zaps, and replies to user
 *
 * @orchestrator NotificationsOrchestrator
 * @purpose Subscribe to events where user is mentioned/tagged/replied to
 * @used-by NotificationsView
 *
 * Architecture:
 * - TWO subscriptions for full coverage (like Nostur):
 *   1. #p filter: Events that tag user directly
 *   2. #e filter: Replies/reactions to user's events
 * - Memory-only cache (no localStorage for notifications)
 * - localStorage only for: last_seen timestamp, user_event_ids
 * - InfiniteScroll support: fetch older with `until` parameter
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { MuteOrchestrator } from '../../lists/mutes';
import { MutualChangeStorage } from '../../lists/MutualChangeStorage';
import { FollowerSnapshotStorage } from '../../lists/FollowerSnapshotStorage';
import { SystemLogger } from '../SystemLogger';
import { AuthService } from '../AuthService';
import { TypedEventBus } from '../../core/TypedEventBus';
import { decodeNip19 } from '../NostrToolsAdapter';
import { PerAccountLocalStorage, StorageKeys } from '../PerAccountLocalStorage';
import { NoteService } from '../NoteService';
import { SoftMuteService } from '../SoftMuteService';
import { USER_CONTENT_KINDS } from '../../types/nostr';
import { getCacheSize } from '../../helpers/LRUCache';
import { isDataSaverEnabled } from '../DataSaverService';

export type NotificationType = 'mention' | 'reply' | 'thread-reply' | 'quote' | 'repost' | 'reaction' | 'zap' | 'zap-reply' | 'article' | 'mutual_unfollow' | 'mutual_new' | 'follower_new' | 'hashtag' | 'poll_vote' | 'highlight' | 'badge-award' | 'dhikr_round' | 'dhikr_commit' | 'dhikr_complete' | 'nostrord' | 'image-tag';

export interface NotificationEvent {
  event: NostrEvent;
  type: NotificationType;
  timestamp: number;
  meta?: { hashtag?: string; count?: number; groupName?: string; isOwn?: boolean; groupRelay?: string }; // hashtag + nostrord notifications
}

export class NotificationsOrchestrator extends Orchestrator {
  private static instance: NotificationsOrchestrator;
  private transport: NostrTransport;
  private muteOrchestrator: ReturnType<typeof MuteOrchestrator.getInstance>;
  private systemLogger: SystemLogger;
  private authService: AuthService;
  private eventBus: TypedEventBus;
  private mutedPubkeys: Set<string> = new Set();
  // Soft-muted pubkeys — notification-only suppression (still appear in feeds/threads/PV).
  private softMutedPubkeys: Set<string> = new Set();
  private mutedEventIds: Set<string> = new Set(); // Thread muting (Hell Thread protection)

  /** Active subscription ID for #p filter */
  private ptagSubId: string | null = null;

  /** Active subscription ID for #e filter */
  private etagSubId: string | null = null;

  /** Current user's pubkey (hex) - used to filter out self-notifications */
  private userPubkey: string | null = null;

  /** Notifications cache (memory-only, sorted by timestamp) */
  private notifications: NotificationEvent[] = [];

  /** Callback for real-time updates */
  private onNewNotificationCallback: ((notification: NotificationEvent) => void) | null = null;

  /** Per-account storage instance */
  private perAccountStorage: PerAccountLocalStorage;

  /** Map of user event ID -> ancestry (root/parent IDs) for muted thread checking */
  private userEventAncestry: Map<string, { rootId: string | null; parentId: string | null }> = new Map();

  /** Cached RelayConfig instance (lazy-loaded) */
  private relayConfig: any = null;

  /** NoteService for caching kind 1 events */
  private noteService: NoteService;

  /** Refresh timer for periodic re-subscription (browser WebSocket connections go stale) */
  private refreshTimer: number | null = null;
  private isRefreshing: boolean = false;
  private static readonly REFRESH_INTERVAL = isDataSaverEnabled() ? 60 * 60 * 1000 : 30 * 60 * 1000;
  private readonly MAX_NOTIFICATIONS = getCacheSize(500, 300, 200);

  private constructor() {
    super('NotificationsOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.muteOrchestrator = MuteOrchestrator.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.authService = AuthService.getInstance();
    this.eventBus = TypedEventBus.getInstance();
    this.perAccountStorage = PerAccountLocalStorage.getInstance();
    this.noteService = NoteService.getInstance();

    this.systemLogger.info('NotificationsOrchestrator', '🔔 Notifications Orchestrator initialized');
  }

  public static getInstance(): NotificationsOrchestrator {
    if (!NotificationsOrchestrator.instance) {
      NotificationsOrchestrator.instance = new NotificationsOrchestrator();
    }
    return NotificationsOrchestrator.instance;
  }

  /**
   * Start notifications subscriptions (called on login)
   * 1. Fetches user's recent events (for #e filter)
   * 2. Fetches last 100 notifications (initial load)
   * 3. Subscribes to new notifications (real-time)
   */
  public async start(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();

    if (!currentUser) {
      this.systemLogger.warn('NotificationsOrchestrator', 'Cannot start - no user logged in');
      return;
    }

    // Idempotency: If already started for this user, skip
    if (this.userPubkey === currentUser.pubkey && this.ptagSubId) {
      this.systemLogger.info('NotificationsOrchestrator', 'Already started for this user, skipping');
      return;
    }

    // If user changed, stop old subscriptions first
    if (this.userPubkey && this.userPubkey !== currentUser.pubkey) {
      this.systemLogger.info('NotificationsOrchestrator', 'User changed, stopping old subscriptions');
      this.stop();
    }

    // Set userPubkey for self-notification filtering
    this.userPubkey = currentUser.pubkey;

    this.systemLogger.info('NotificationsOrchestrator', `🚀 Starting notifications for ${currentUser.npub.slice(0, 12)}...`);

    // Step 0: Load muted users
    await this.loadMutedUsers(currentUser.pubkey);

    // Step 0.1: Load soft-muted pubkeys (notification-only suppression)
    this.loadSoftMutedUsers();

    // Step 0.5: Load user event ancestry from localStorage (for muted thread checking)
    this.loadUserEventAncestry();

    // Step 1: Fetch and store user's recent events (for #e filter)
    await this.fetchAndStoreUserEvents(currentUser.pubkey);

    // Step 2: Fetch initial notifications (last 100)
    await this.fetchInitialNotifications(currentUser.pubkey);

    // Step 2.5: Restore mutual change notifications from storage
    // First ensure storage is initialized from file
    const mutualStorage = MutualChangeStorage.getInstance();
    await mutualStorage.initFromFile();
    this.restoreMutualChangeNotifications(currentUser.pubkey);

    // Step 2.6: Restore follower change notifications from storage (follower-notification addon)
    const followerStorage = FollowerSnapshotStorage.getInstance();
    await followerStorage.initFromFile();
    this.restoreFollowerChangeNotifications(currentUser.pubkey);

    // Step 3: Subscribe to new notifications (real-time)
    await this.subscribeToLive();

    // Step 4: Start periodic refresh timer (browser WebSocket connections go stale)
    this.startRefreshTimer();

    // Listen for article notification events
    this.eventBus.on('article-notification:new', (data: { pubkey: string; articleId: string; naddr: string; title: string; createdAt: number }) => {
      this.handleNewArticleNotification(data);
    });

    // Listen for mutual change notification events
    this.eventBus.on('mutual-notification:new', (data: { event: NostrEvent; type: 'mutual_unfollow' | 'mutual_new' }) => {
      this.handleMutualNotification(data);
    });

    // Listen for follower change notification events (follower-notification addon)
    this.eventBus.on('follower-notification:new', (data: { event: NostrEvent; type: 'follower_new' }) => {
      this.handleFollowerNotification(data);
    });

    // Listen for community-dhikr notification events (nostr-majlis addon)
    this.eventBus.on('dhikr-notification:new', (data: { event: NostrEvent; type: 'dhikr_round' | 'dhikr_commit' | 'dhikr_complete' }) => {
      this.handleDhikrNotification(data);
    });

    // Listen for Nostrord NIP-29 group activity notifications (nostrord addon)
    this.eventBus.on('nostrord-notification:new', (data: { event: NostrEvent; groupName: string; mine?: boolean; groupRelay?: string }) => {
      this.handleNostrordNotification(data);
    });

    // Listen for hashtag notification events
    this.eventBus.on('hashtag:new-posts', (data: { hashtag: string; count: number; latestEvent: NostrEvent }) => {
      this.handleHashtagNotification(data);
    });

    // Listen for user mute changes (refresh filter when user is muted/unmuted)
    this.eventBus.on('mute:updated', () => {
      this.refreshMutedUsers();
    });

    // Listen for thread mute changes (Hell Thread protection)
    this.eventBus.on('mute:thread:updated', () => {
      this.refreshMutedUsers();
    });

    // Listen for soft-mute changes (notification-only suppression)
    this.eventBus.on('soft-mute:updated', () => {
      this.refreshMutedUsers();
    });
  }

  /**
   * Subscribe to live notification events
   * Extracted from start() for reuse by refreshSubscriptions()
   */
  private async subscribeToLive(): Promise<void> {
    if (!this.userPubkey) return;

    const now = Math.floor(Date.now() / 1000);
    const relays = await this.getReadRelays();

    // Filter 1: Direct mentions/tags (#p filter)
    const ptagFilter: NDKFilter = {
      '#p': [this.userPubkey],
      kinds: [1, 6, 7, 8, 16, 20, 21, 22, 1111, 9735, 9802] as any,
      since: now
    };

    this.ptagSubId = 'notifications-ptag';
    this.transport.subscribeLive(
      relays,
      [ptagFilter],
      this.ptagSubId,
      (event: NostrEvent, _relay: string) => {
        this.onmessage(_relay, event);
      }
    );

    this.systemLogger.info('NotificationsOrchestrator', `✅ #p subscription active (${this.ptagSubId})`);

    // Filter 2: Replies to user's events (#e filter)
    const userEventIds = this.getUserEventIds();
    if (userEventIds.length > 0) {
      const etagFilter: NDKFilter = {
        '#e': userEventIds,
        kinds: [1, 7, 20, 21, 22, 1018, 1111, 9735, 9802] as any,
        since: now
      };

      this.etagSubId = 'notifications-etag';
      this.transport.subscribeLive(
        relays,
        [etagFilter],
        this.etagSubId,
        (event: NostrEvent, _relay: string) => {
          this.onmessage(_relay, event);
        }
      );

      this.systemLogger.info('NotificationsOrchestrator', `✅ #e subscription active (${this.etagSubId}) - tracking ${userEventIds.length} events`);
    } else {
      this.systemLogger.warn('NotificationsOrchestrator', '⚠️ No user event IDs found - #e filter skipped');
    }
  }

  /**
   * Refresh subscriptions - closes stale ones and re-subscribes
   * Called periodically and on tab visibility change to recover from
   * silent WebSocket/relay disconnections (common in browsers)
   */
  public async refreshSubscriptions(): Promise<void> {
    if (!this.userPubkey || this.isRefreshing) return;

    this.isRefreshing = true;
    try {
      this.systemLogger.info('NotificationsOrchestrator', '🔄 Refreshing subscriptions...');

      // 1. Close existing subscriptions
      if (this.ptagSubId) {
        this.transport.unsubscribeLive(this.ptagSubId);
        this.ptagSubId = null;
      }
      if (this.etagSubId) {
        this.transport.unsubscribeLive(this.etagSubId);
        this.etagSubId = null;
      }

      // 2. Fetch missed notifications since latest known
      const latestTimestamp = this.notifications[0]?.timestamp
        ?? Math.floor(Date.now() / 1000) - 1800;
      await this.fetchNewNotifications(latestTimestamp);

      // 3. Re-subscribe to live events
      await this.subscribeToLive();

      // 4. Reset timer so it counts from now (avoids redundant refresh after visibility change)
      this.startRefreshTimer();

      this.systemLogger.info('NotificationsOrchestrator', '✅ Subscriptions refreshed');
    } finally {
      this.isRefreshing = false;
    }
  }

  /** Start periodic refresh timer */
  private startRefreshTimer(): void {
    this.clearRefreshTimer();
    this.refreshTimer = window.setInterval(() => {
      this.refreshSubscriptions();
    }, NotificationsOrchestrator.REFRESH_INTERVAL);
  }

  /** Clear periodic refresh timer */
  private clearRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Fetch initial notifications (last 100 from relays)
   * Always fetches fresh from relays (no localStorage cache)
   */
  private async fetchInitialNotifications(userPubkey: string): Promise<void> {
    try {
      const relays = await this.getReadRelays();
      this.systemLogger.info('NotificationsOrchestrator', '📥 Fetching last 100 notifications from relays');

      // Build filter for last 100 notifications
      const ptagFilter: NDKFilter = {
        '#p': [userPubkey],
        kinds: [1, 6, 7, 8, 16, 20, 21, 22, 1111, 9735, 9802] as any,
        limit: 100
      };

      // skipCache: true — bypass NDK Dexie cache to always get fresh relay data
      const ptagNotifications = await this.transport.fetch(relays, [ptagFilter], 5000, true, 'NotifOrch');

      this.systemLogger.info('NotificationsOrchestrator', `✅ Fetched ${ptagNotifications.length} #p notifications`);

      // Fetch #e notifications
      const userEventIds = this.getUserEventIds();
      let etagNotifications: any[] = [];
      if (userEventIds.length > 0) {
        const etagFilter: NDKFilter = {
          '#e': userEventIds,
          kinds: [1, 7, 20, 21, 22, 1018, 1111, 9735, 9802] as any,
          limit: 100
        };

        etagNotifications = await this.transport.fetch(relays, [etagFilter], 5000, true, 'NotifOrch');

        this.systemLogger.info('NotificationsOrchestrator', `✅ Fetched ${etagNotifications.length} #e notifications`);
      }

      // Process all fetched notifications
      const allNotifications = [...ptagNotifications, ...etagNotifications];

      allNotifications.forEach(event => {
        this.processNotificationEvent(event);
      });

      this.systemLogger.info('NotificationsOrchestrator', `📋 Total notifications loaded: ${this.notifications.length}`);

      this.eventBus.emit('notifications:badge-update');
    } catch (error) {
      this.systemLogger.error('NotificationsOrchestrator', 'Failed to fetch initial notifications:', error);
    }
  }

  /**
   * Add cached notifications into orchestrator (for cache restoration)
   * @param events Array of NostrEvents from cache
   */
  public addCachedNotifications(events: NostrEvent[]): void {
    this.systemLogger.info('NotificationsOrchestrator', `📥 Loading ${events.length} cached notifications`);

    events.forEach(event => {
      this.processNotificationEvent(event);
    });

    this.systemLogger.info('NotificationsOrchestrator', `✅ Loaded ${this.notifications.length} total notifications (including cache)`);
  }

  /**
   * Fetch new notifications since a timestamp
   * @param since Timestamp - fetch notifications newer than this
   * @returns Promise<void>
   */
  public async fetchNewNotifications(since: number): Promise<void> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return;

      const relays = await this.getReadRelays();
      this.systemLogger.info('NotificationsOrchestrator', `📥 Fetching new notifications (since: ${since})`);

      // Build filter for new notifications
      const ptagFilter: NDKFilter = {
        '#p': [currentUser.pubkey],
        kinds: [1, 6, 7, 8, 16, 20, 21, 22, 1111, 9735, 9802] as any,
        since: since
      };

      // Fetch #p notifications (skipCache for fresh data)
      const ptagNotifications = await this.transport.fetch(relays, [ptagFilter], 5000, true, 'NotifOrch');

      // Fetch #e notifications (skipCache for fresh data)
      const userEventIds = this.getUserEventIds();
      let etagNotifications: any[] = [];
      if (userEventIds.length > 0) {
        const etagFilter: NDKFilter = {
          '#e': userEventIds,
          kinds: [1, 7, 20, 21, 22, 1018, 1111, 9735, 9802] as any,
          since: since
        };

        etagNotifications = await this.transport.fetch(relays, [etagFilter], 5000, true, 'NotifOrch');
      }

      // Process all fetched notifications
      const allNotifications = [...ptagNotifications, ...etagNotifications];

      allNotifications.forEach(event => {
        this.processNotificationEvent(event);
      });

      this.systemLogger.info('NotificationsOrchestrator', `✅ Loaded ${allNotifications.length} new notifications`);

      this.eventBus.emit('notifications:badge-update');
    } catch (error) {
      this.systemLogger.error('NotificationsOrchestrator', 'Failed to fetch new notifications:', error);
    }
  }

  /**
   * Get all notification events (raw NostrEvents) for caching
   * @returns Array of NostrEvents
   */
  public getAllNotificationEvents(): NostrEvent[] {
    // Exclude hashtag and mutual notifications from cache — they are transient.
    // Hashtags are regenerated by polling, mutuals from MutualChangeStorage.
    // Caching them loses the type info (kind 99001 falls back to 'mention').
    return this.notifications
      .filter(n => n.type !== 'hashtag' && n.type !== 'mutual_new' && n.type !== 'mutual_unfollow'
        && n.type !== 'follower_new'
        && n.type !== 'dhikr_round' && n.type !== 'dhikr_commit' && n.type !== 'dhikr_complete'
        && n.type !== 'nostrord')
      .map(n => n.event);
  }

  /**
   * Fetch older notifications for InfiniteScroll
   * @param until Timestamp - fetch notifications older than this
   * @param limit Number of notifications to fetch (default: 50)
   * @returns Array of newly fetched notifications
   */
  public async fetchOlderNotifications(until: number, limit: number = 50): Promise<NotificationEvent[]> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return [];

      const relays = await this.getReadRelays();
      this.systemLogger.info('NotificationsOrchestrator', `📥 Fetching ${limit} older notifications (until: ${until})`);

      // Build filter for older notifications
      const ptagFilter: NDKFilter = {
        '#p': [currentUser.pubkey],
        kinds: [1, 6, 7, 8, 16, 20, 21, 22, 1111, 9735, 9802] as any,
        until: until,
        limit: limit
      };

      // Fetch #p notifications
      const ptagNotifications = await this.transport.fetch(relays, [ptagFilter], 5000, false, 'NotifOrch');

      // Fetch #e notifications
      const userEventIds = this.getUserEventIds();
      let etagNotifications: any[] = [];
      if (userEventIds.length > 0) {
        const etagFilter: NDKFilter = {
          '#e': userEventIds,
          kinds: [1, 7, 20, 21, 22, 1018, 1111, 9735, 9802] as any,
          until: until,
          limit: limit
        };

        etagNotifications = await this.transport.fetch(relays, [etagFilter], 5000, false, 'NotifOrch');
      }

      // Process all fetched notifications
      const allNotifications = [...ptagNotifications, ...etagNotifications];
      const newNotifications: NotificationEvent[] = [];

      allNotifications.forEach(event => {
        if (this.processNotificationEvent(event)) {
          const notification = this.notifications.find(n => n.event.id === event.id);
          if (notification) {
            newNotifications.push(notification);
          }
        }
      });

      this.systemLogger.info('NotificationsOrchestrator', `✅ Loaded ${newNotifications.length} older notifications`);
      return newNotifications;
    } catch (error) {
      this.systemLogger.error('NotificationsOrchestrator', 'Failed to fetch older notifications:', error);
      return [];
    }
  }

  /**
   * Process a notification event (add to cache + notifications list)
   */
  private processNotificationEvent(event: NostrEvent): boolean {
    // Skip events from the user themselves (don't show self-mentions, self-zaps, etc.)
    if (this.userPubkey && event.pubkey === this.userPubkey) {
      return false;
    }

    // Skip events from muted users (full mute OR soft mute — both suppress notifications)
    if (this.isAuthorMutedOrSoftMuted(event.pubkey)) {
      return false;
    }

    // Skip events from muted threads (Hell Thread protection)
    if (this.isEventInMutedThread(event)) {
      return false;
    }

    // Skip notifications about user's events within muted threads
    // (e.g., likes/replies to user's posts inside a muted hell thread)
    if (this.isNotificationTargetInMutedThread(event)) {
      return false;
    }

    // Owner-only filter for FollowPack (kind 39089) interactions.
    // Reactions/replies/zaps/reposts on a FollowPack we don't own are
    // uninteresting — a user can be p-tagged just because their pubkey
    // appears in the pack's member list.
    if (this.userPubkey) {
      const aTag = event.tags.find(t => t[0] === 'a');
      if (aTag?.[1]) {
        const parts = aTag[1].split(':');
        const targetKind = parseInt(parts[0] || '');
        const targetAuthor = parts[1];
        if (targetKind === 39089 && targetAuthor && targetAuthor !== this.userPubkey) {
          return false;
        }
      }
    }

    // Skip reactions whose direct target is NOT the user's own event
    // NIP-25: last p-tag is the direct target (Jumble pattern). Some clients copy
    // root/parent thread p-tags, causing false "reacted to your note" notifications.
    // Zaps (9735) are NOT filtered here — their p-tag is set by the LNURL server,
    // so the #p subscription filter is authoritative.
    if (event.kind === 7 && this.userPubkey) {
      const pTags = event.tags.filter(t => t[0] === 'p');
      const eTags = event.tags.filter(t => t[0] === 'e');
      const eTagId = eTags[eTags.length - 1]?.[1];
      const userEventIds = this.getUserEventIds();
      const targetsUserEvent = !!(eTagId && userEventIds.includes(eTagId));
      const directTarget = pTags[pTags.length - 1]?.[1];
      const lastPtagIsUser = directTarget === this.userPubkey;

      if (!targetsUserEvent && !lastPtagIsUser) {
        return false;
      }
    }

    // Detect notification type
    const type = this.getNotificationType(event);

    // Create notification
    const notification: NotificationEvent = {
      event,
      type,
      timestamp: event.created_at
    };

    // Add to notifications (dedup + sort + trim handled by addNotification)
    // Return value is authoritative — at MAX_NOTIFICATIONS the array length
    // stays constant after trim, so length-based detection would miss this add.
    const added = this.addNotification(notification);
    if (added && event.kind === 1) {
      this.noteService.registerNote(event);
    }
    return added;
  }

  /**
   * Central method: add a notification with dedup, sort, and size limit.
   * Returns true if notification was added (not a duplicate).
   */
  private addNotification(notification: NotificationEvent, dedupKey?: string): boolean {
    const key = dedupKey ?? notification.event.id;
    const exists = this.notifications.some(n => n.event.id === key);
    if (exists) return false;

    this.notifications.push(notification);
    this.notifications.sort((a, b) => b.timestamp - a.timestamp);

    // Trim to max size (oldest removed, can be re-fetched via loadMore)
    if (this.notifications.length > this.MAX_NOTIFICATIONS) {
      this.notifications.length = this.MAX_NOTIFICATIONS;
    }

    return true;
  }

  /**
   * Fetch user's recent events and store IDs for #e filter
   */
  private async fetchAndStoreUserEvents(userPubkey: string): Promise<void> {
    try {
      const relays = await this.getReadRelays();
      const userEvents = await this.transport.fetch(relays, [{
        authors: [userPubkey],
        kinds: USER_CONTENT_KINDS,
        limit: 50
      }], 5000, false, 'NotifOrch');

      const eventIds = userEvents.map(e => e.id);
      this.perAccountStorage.set(StorageKeys.USER_EVENT_IDS, eventIds);

      // Store ancestry (root/parent) for each user event (for muted thread checking)
      const ancestryMap: Record<string, { rootId: string | null; parentId: string | null }> = {};
      for (const event of userEvents) {
        if (!event.id) continue;

        const eTags = event.tags.filter(t => t[0] === 'e');

        // Extract root ID (NIP-10: "root" marker or first e-tag if multiple)
        const rootTag = eTags.find(t => t[3] === 'root');
        const firstETag = eTags[0];
        const rootId = rootTag?.[1] ?? (eTags.length > 1 && firstETag ? firstETag[1] : null) ?? null;

        // Extract parent ID (NIP-10: "reply" marker or last e-tag)
        const replyTag = eTags.find(t => t[3] === 'reply');
        const lastETag = eTags[eTags.length - 1];
        const parentId = replyTag?.[1] ?? (eTags.length > 0 && lastETag ? lastETag[1] : null) ?? null;

        ancestryMap[event.id] = { rootId, parentId };
        this.userEventAncestry.set(event.id, { rootId, parentId });
      }
      this.perAccountStorage.set(StorageKeys.USER_EVENT_ANCESTRY, ancestryMap);

      this.systemLogger.info('NotificationsOrchestrator', `📋 Stored ${eventIds.length} user event IDs with ancestry`);
    } catch (error) {
      this.systemLogger.error('NotificationsOrchestrator', 'Failed to fetch user events:', error);
    }
  }

  /**
   * Stop notifications subscriptions (called on logout)
   */
  public stop(): void {
    this.clearRefreshTimer();

    if (this.ptagSubId) {
      this.transport.unsubscribeLive(this.ptagSubId);
      this.ptagSubId = null;
    }

    if (this.etagSubId) {
      this.transport.unsubscribeLive(this.etagSubId);
      this.etagSubId = null;
    }

    this.userPubkey = null;
    this.notifications = [];
    this.onNewNotificationCallback = null;

    this.systemLogger.info('NotificationsOrchestrator', '🛑 Notifications stopped');
  }

  /**
   * Get all notifications (sorted by timestamp, newest first)
   * @param type Optional filter by notification type
   * @param offset Offset for pagination (default: 0)
   * @param limit Limit for pagination (default: all)
   */
  public getNotifications(type?: NotificationType, offset: number = 0, limit?: number): NotificationEvent[] {
    let filtered = type
      ? this.notifications.filter(n => n.type === type)
      : this.notifications;

    // Apply pagination if limit is specified
    if (limit !== undefined) {
      filtered = filtered.slice(offset, offset + limit);
    }

    return filtered;
  }

  /**
   * Get total count of notifications (for pagination)
   */
  public getNotificationCount(type?: NotificationType): number {
    if (type) {
      return this.notifications.filter(n => n.type === type).length;
    }
    return this.notifications.length;
  }

  /**
   * Get unread count
   */
  public getUnreadCount(): number {
    const lastSeen = this.getLastSeenTimestamp();

    // First start (no lastSeen): all notifications are unread
    if (!lastSeen) {
      return this.notifications.length;
    }

    // Subsequent starts: only notifications after lastSeen are unread
    return this.notifications.filter(n => n.timestamp > lastSeen).length;
  }

  /**
   * Check if all unread notifications are hashtag-only
   * Used by badge to show different indicator for low-priority hashtag notifications
   */
  public hasOnlyHashtagUnread(): boolean {
    const lastSeen = this.getLastSeenTimestamp();
    const unread = lastSeen
      ? this.notifications.filter(n => n.timestamp > lastSeen)
      : this.notifications;

    if (unread.length === 0) return false;

    return unread.every(n => n.type === 'hashtag');
  }

  /**
   * Get the highest priority among unread notifications
   * Priority 1 = highest (pulsing), 2 = normal (solid), 3 = lowest (hollow)
   * Returns null if no unread notifications
   */
  public getHighestUnreadPriority(): 1 | 2 | 3 | null {
    const lastSeen = this.getLastSeenTimestamp();
    const unread = lastSeen
      ? this.notifications.filter(n => n.timestamp > lastSeen)
      : this.notifications;

    if (unread.length === 0) return null;

    // Default priorities
    const defaultPriorities: Record<string, 1 | 2 | 3> = {
      'reply': 1,
      'quote': 1,
      'zap': 1,
      'mention': 2,
      'repost': 2,
      'reaction': 2,
      'poll_vote': 2,
      'article': 2,
      'mutual_new': 2,
      'mutual_unfollow': 2,
      'follower_new': 2,
      'thread-reply': 3,
      'hashtag': 3,
      'dhikr_round': 3,
      'dhikr_commit': 3,
      'dhikr_complete': 3,
      'nostrord': 3,
    };

    // Load user's priority settings (or use defaults)
    const effectivePriorities = this.perAccountStorage.get<Record<string, 1 | 2 | 3>>(
      StorageKeys.NOTIFICATION_PRIORITIES,
      defaultPriorities
    );

    // Find highest priority (lowest number) among unread
    let highestPriority: 1 | 2 | 3 = 3;
    for (const notification of unread) {
      const priority = effectivePriorities[notification.type] || 2;
      if (priority < highestPriority) {
        highestPriority = priority;
      }
      // Early exit if we found priority 1
      if (highestPriority === 1) break;
    }

    return highestPriority;
  }

  /**
   * Mark notifications as read (update last seen timestamp)
   */
  public markAsRead(): void {
    const now = Math.floor(Date.now() / 1000);
    this.perAccountStorage.set(StorageKeys.NOTIFICATIONS_LAST_SEEN, now);
    this.systemLogger.info('NotificationsOrchestrator', `✅ Marked as read (${now})`);
  }

  /**
   * Set callback for real-time notification updates
   */
  public onNewNotification(callback: (notification: NotificationEvent) => void): void {
    this.onNewNotificationCallback = callback;
  }

  /**
   * Get user's event IDs from per-account storage (for #e filter)
   */
  private getUserEventIds(): string[] {
    return this.perAccountStorage.get<string[]>(StorageKeys.USER_EVENT_IDS, []);
  }

  /**
   * Resolve the relay set to query for notifications.
   *
   * Notifications are the hard case for NIP-65 Outbound: reactors are
   * unknown in advance, so we cannot pre-resolve their write-relays
   * without unioning every follow's outbound — which would blow past
   * the browser's ~256-WebSocket-per-origin limit on healthy networks
   * (200 follows × 3-5 relays each easily reaches 600+ unique URLs).
   *
   * Pragmatic strategy mirrors Amethyst's `NotificationRelayService`:
   * stay bounded with own NIP-65 read-relays + aggregator-relays. That
   * catches every reactor whose client publishes to mainstream relays.
   * The Private-Relay-only-reactor case is the accepted residual gap —
   * a notification feed missing a few obscure-relay reactions is far
   * better than a crashed tab.
   */
  private async getReadRelays(): Promise<string[]> {
    if (!this.relayConfig) {
      const { RelayConfig } = await import('../RelayConfig');
      this.relayConfig = RelayConfig.getInstance();
    }
    const set = new Set<string>(this.relayConfig.getReadRelays());
    this.relayConfig.getAggregatorRelays().forEach((r: string) => set.add(r));
    return [...set];
  }

  /**
   * Load user event ancestry from per-account storage into memory
   */
  private loadUserEventAncestry(): void {
    const ancestryMap = this.perAccountStorage.get<Record<string, { rootId: string | null; parentId: string | null }>>(
      StorageKeys.USER_EVENT_ANCESTRY,
      {}
    );

    this.userEventAncestry.clear();
    for (const [eventId, ancestry] of Object.entries(ancestryMap)) {
      this.userEventAncestry.set(eventId, ancestry);
    }
  }

  /**
   * Check if a notification's target event (user's event being liked/replied to) is in a muted thread
   * This catches notifications about interactions with user's posts within muted threads
   */
  private isNotificationTargetInMutedThread(event: NostrEvent): boolean {
    if (this.mutedEventIds.size === 0) return false;

    // Get the e-tag from the notification (points to user's event)
    const eTag = event.tags.find(t => t[0] === 'e');
    const targetEventId = eTag?.[1];
    if (!targetEventId) return false;

    // Check if target event itself is muted
    if (this.mutedEventIds.has(targetEventId)) return true;

    // Check if target event's ancestry is muted
    const ancestry = this.userEventAncestry.get(targetEventId);
    if (ancestry) {
      if (ancestry.rootId && this.mutedEventIds.has(ancestry.rootId)) return true;
      if (ancestry.parentId && this.mutedEventIds.has(ancestry.parentId)) return true;
    }

    return false;
  }

  /**
   * Get last seen timestamp from per-account storage
   */
  private getLastSeenTimestamp(): number | null {
    return this.perAccountStorage.get<number | null>(StorageKeys.NOTIFICATIONS_LAST_SEEN, null);
  }

  /**
   * Check if user is mentioned in event content (nostr:npub... or nostr:nprofile...)
   */
  private isUserMentionedInContent(content: string, userPubkey: string): boolean {
    const mentionRegex = /nostr:(npub1[023456789acdefghjklmnpqrstuvwxyz]{58}|nprofile1[023456789acdefghjklmnpqrstuvwxyz]{58,})/g;
    const mentions = content.matchAll(mentionRegex);

    for (const match of mentions) {
      try {
        const nip19 = match[1];
        if (!nip19) continue;

        if (nip19.startsWith('npub')) {
          const decoded = decodeNip19(nip19);
          if (decoded.type === 'npub' && decoded.data === userPubkey) {
            return true;
          }
        } else if (nip19.startsWith('nprofile')) {
          const decoded = decodeNip19(nip19);
          if (decoded.type === 'nprofile' && decoded.data.pubkey === userPubkey) {
            return true;
          }
        }
      } catch {
        continue;
      }
    }

    return false;
  }

  /**
   * NIP-68 image-tag detection: returns true when the event carries at least
   * one `imeta` tag whose `annotate-user <pubkey>:<x>:<y>` line references the
   * given user. Used to classify an incoming tagged-post notification as
   * 'image-tag' rather than the generic 'mention'.
   */
  private hasImageTagForUser(event: NostrEvent, userPubkey: string): boolean {
    const imetaTags = event.tags.filter(t => t[0] === 'imeta');
    for (const tag of imetaTags) {
      for (let i = 1; i < tag.length; i++) {
        const prop = tag[i];
        if (!prop || !prop.startsWith('annotate-user ')) continue;
        const value = prop.substring('annotate-user '.length);
        // Format: "<pubkey_hex>:<x>:<y>"
        const match = value.match(/^([0-9a-f]{64}):\d+:\d+$/);
        if (match && match[1] === userPubkey) return true;
      }
    }
    return false;
  }

  /**
   * Detect notification type from event
   */
  private getNotificationType(event: NostrEvent): NotificationType {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return 'mention';

    const userEventIds = this.getUserEventIds();

    if (event.kind === 1 || event.kind === 20) {
      const hasUserPtag = event.tags.some(t => t[0] === 'p' && t[1] === currentUser.pubkey);
      const hasAnyEtag = event.tags.some(t => t[0] === 'e');
      const userMentionedInContent = this.isUserMentionedInContent(event.content, currentUser.pubkey);

      // NIP-68 image-tag: event has imeta with `annotate-user <myPubkey>:x:y`.
      // Takes precedence over plain mention classification so the action text
      // reads "tagged you in an image" rather than the generic "mentioned you".
      if (hasUserPtag && this.hasImageTagForUser(event, currentUser.pubkey)) {
        return 'image-tag';
      }

      // Check for quoted repost (q-tag pointing to user's event)
      const qTag = event.tags.find(t => t[0] === 'q');
      const quotedEventId = qTag?.[1];
      if (quotedEventId && userEventIds.includes(quotedEventId)) {
        return 'quote';
      }

      // Check if this is a direct reply to user's event.
      // The direct reply target is resolved in priority order:
      //   1. NIP-10 'reply' marker (the event being responded to)
      //   2. NIP-10 'root' marker (a direct reply to the root has no 'reply' marker)
      //   3. Deprecated positional NIP-10: the last 'e' tag is the direct parent
      // Without the positional fallback, unmarked replies (common from many clients)
      // are misclassified as low-priority thread-replies instead of high-priority replies.
      const eTags = event.tags.filter(t => t[0] === 'e');
      const markedReplyId = eTags.find(t => t[3] === 'reply')?.[1];
      const markedRootId = eTags.find(t => t[3] === 'root')?.[1];
      const directTargetId = markedReplyId ?? markedRootId ?? eTags[eTags.length - 1]?.[1];

      const isDirectReplyToUser = !!(directTargetId && userEventIds.includes(directTargetId));

      // Priority 1: Direct reply to user's own event
      if (isDirectReplyToUser) return 'reply';

      // Priority 2: User mentioned in content
      if (hasUserPtag && userMentionedInContent) return 'mention';

      // Priority 3: Reply in a thread where user was mentioned (thread-reply)
      // This happens when someone replies in a thread that contains user's event as 'root'
      // but the direct 'reply' marker points to someone else's event
      if (hasUserPtag && hasAnyEtag && !userMentionedInContent) return 'thread-reply';

      // Edge case: User has p-tag but no e-tag and not in content
      if (hasUserPtag) return 'mention';
    }

    // NIP-22 Comments (kind 1111) — parallel to kind 1/20 but with NIP-22 tag conventions:
    //   lowercase 'e' = parent event (direct reply target)
    //   uppercase 'E' = root event (thread root)
    //   lowercase/uppercase 'p'/'P' = mentioned pubkeys
    // No marker strings (unlike NIP-10).
    if (event.kind === 1111) {
      // A comment whose NIP-22 root/parent is a zap receipt (K/k = 9735) is a reply within a zap
      // thread — its own priority category so users can tune "Zap Reply" notifications separately.
      if (event.tags.some(t => (t[0] === 'K' || t[0] === 'k') && t[1] === '9735')) {
        return 'zap-reply';
      }

      const hasUserPtag = event.tags.some(t => (t[0] === 'p' || t[0] === 'P') && t[1] === currentUser.pubkey);
      const hasAnyEtag = event.tags.some(t => t[0] === 'e' || t[0] === 'E');
      const userMentionedInContent = this.isUserMentionedInContent(event.content, currentUser.pubkey);

      const qTag = event.tags.find(t => t[0] === 'q');
      const quotedEventId = qTag?.[1];
      if (quotedEventId && userEventIds.includes(quotedEventId)) {
        return 'quote';
      }

      const parentTargetId = event.tags.find(t => t[0] === 'e')?.[1];
      const rootTargetId = event.tags.find(t => t[0] === 'E')?.[1];

      const isDirectReplyToUser = (parentTargetId && userEventIds.includes(parentTargetId)) ||
                                  (rootTargetId && userEventIds.includes(rootTargetId) && !parentTargetId);

      if (isDirectReplyToUser) return 'reply';
      if (hasUserPtag && userMentionedInContent) return 'mention';
      if (hasUserPtag && hasAnyEtag && !userMentionedInContent) return 'thread-reply';
      if (hasUserPtag) return 'mention';
    }

    if (event.kind === 6 || event.kind === 16) return 'repost';
    if (event.kind === 7) return 'reaction';
    if (event.kind === 8) return 'badge-award';
    if (event.kind === 1018) return 'poll_vote';
    if (event.kind === 9735) return 'zap';
    if (event.kind === 9802) return 'highlight';

    return 'mention'; // fallback
  }

  // ========== Orchestrator Interface ==========

  public onui(_data: any): void {
    // Not used for notifications (no UI-triggered actions)
  }

  public onopen(relay: string): void {
    this.systemLogger.info('NotificationsOrchestrator', `📡 Connected to ${relay}`);
  }

  public onmessage(_relay: string, event: NostrEvent): void {
    // Use return value (not length delta) — at MAX_NOTIFICATIONS the array is trimmed
    // back to limit, so length-based detection would miss live adds when cache is full.
    const wasAdded = this.processNotificationEvent(event);

    if (wasAdded) {
      const notification = this.notifications.find(n => n.event.id === event.id);
      if (notification) {
        this.systemLogger.info('NotificationsOrchestrator', `🔔 New ${notification.type}: ${event.id?.slice(0, 8) ?? 'unknown'}...`);

        // Trigger callback for real-time updates
        if (this.onNewNotificationCallback) {
          this.onNewNotificationCallback(notification);
        }

        this.eventBus.emit('notifications:badge-update');
      }
    }
  }

  public onerror(relay: string, error: Error): void {
    this.systemLogger.error('NotificationsOrchestrator', `❌ Error from ${relay}:`, error);
  }

  public onclose(relay: string): void {
    this.systemLogger.info('NotificationsOrchestrator', `📡 Disconnected from ${relay}`);
  }

  /**
   * Load muted users and threads from MuteOrchestrator
   */
  private async loadMutedUsers(userPubkey: string): Promise<void> {
    try {
      // Load muted users
      const mutedPubkeys = await this.muteOrchestrator.getAllMutedUsers(userPubkey);
      this.mutedPubkeys = new Set(mutedPubkeys);

      // Load muted threads (Hell Thread protection)
      const mutedEventIds = await this.muteOrchestrator.getAllMutedEventIds();
      this.mutedEventIds = new Set(mutedEventIds);

      if (mutedPubkeys.length > 0 || mutedEventIds.length > 0) {
        this.systemLogger.info('NotificationsOrchestrator', `Loaded ${mutedPubkeys.length} muted users, ${mutedEventIds.length} muted threads`);
      }
    } catch (error) {
      this.systemLogger.error('NotificationsOrchestrator', `Failed to load muted users: ${error}`);
    }
  }

  /**
   * Load soft-muted pubkeys from SoftMuteService into the in-memory filter set.
   * Soft mute is notification-only: posts still appear in feeds/threads/PV.
   */
  private loadSoftMutedUsers(): void {
    try {
      const map = SoftMuteService.getInstance().getAll();
      this.softMutedPubkeys = new Set(Object.keys(map));
      if (this.softMutedPubkeys.size > 0) {
        this.systemLogger.info('NotificationsOrchestrator', `Loaded ${this.softMutedPubkeys.size} soft-muted users`);
      }
    } catch (error) {
      this.systemLogger.error('NotificationsOrchestrator', `Failed to load soft-muted users: ${error}`);
    }
  }

  /**
   * Combined mute check for notification filtering. Returns true if the pubkey
   * is either fully muted OR soft-muted (both suppress notifications).
   */
  private isAuthorMutedOrSoftMuted(pubkey: string): boolean {
    return this.mutedPubkeys.has(pubkey) || this.softMutedPubkeys.has(pubkey);
  }

  /**
   * Check if event is part of a muted thread (synchronous check)
   * Checks: event ID, parent ID, root ID
   */
  private isEventInMutedThread(event: NostrEvent): boolean {
    if (this.mutedEventIds.size === 0) return false;

    // Check 1: Event itself is muted
    if (event.id && this.mutedEventIds.has(event.id)) return true;

    // Extract e-tags for parent/root check
    const eTags = event.tags.filter(tag => tag[0] === 'e');
    if (eTags.length === 0) return false;

    // Check 2: Root is muted (NIP-10: "root" marker or first e-tag)
    const rootTag = eTags.find(tag => tag[3] === 'root');
    const firstETag = eTags[0];
    const rootId = rootTag?.[1] ?? (eTags.length > 1 && firstETag ? firstETag[1] : null);
    if (rootId && this.mutedEventIds.has(rootId)) return true;

    // Check 3: Parent is muted (NIP-10: "reply" marker or last e-tag)
    const replyTag = eTags.find(tag => tag[3] === 'reply');
    const lastETag = eTags[eTags.length - 1];
    const parentId = replyTag?.[1] ?? lastETag?.[1];
    if (parentId && this.mutedEventIds.has(parentId)) return true;

    return false;
  }

  /**
   * Refresh muted users list (called when mute list is updated)
   */
  public async refreshMutedUsers(): Promise<void> {
    if (this.userPubkey) {
      await this.loadMutedUsers(this.userPubkey);

      // Filter existing notifications (users, threads, and notifications about user's posts in muted threads)
      this.notifications = this.notifications.filter(n =>
        !this.isAuthorMutedOrSoftMuted(n.event.pubkey) &&
        !this.isEventInMutedThread(n.event) &&
        !this.isNotificationTargetInMutedThread(n.event)
      );

      // Notify UI to refresh (NotificationsView listens for this)
      this.eventBus.emit('notifications:filtered');
    }
  }

  /**
   * Handle new article notification from ArticleNotificationService
   */
  private async handleNewArticleNotification(data: { pubkey: string; articleId: string; naddr: string; title: string; createdAt: number }): Promise<void> {
    // Skip if from muted user (full mute OR soft mute)
    if (this.isAuthorMutedOrSoftMuted(data.pubkey)) {
      return;
    }

    // Create a synthetic notification entry
    const notification: NotificationEvent = {
      type: 'article',
      event: {
        id: data.articleId,
        pubkey: data.pubkey,
        kind: 30023,
        created_at: data.createdAt,
        tags: [['d', data.naddr], ['title', data.title]],
        content: data.title,
        sig: ''
      } as NostrEvent,
      timestamp: data.createdAt
    };

    if (!this.addNotification(notification)) return;

    this.systemLogger.info('NotificationsOrchestrator', `📰 New article notification: ${data.title.slice(0, 30)}...`);

    this.eventBus.emit('notifications:badge-update');
    this.eventBus.emit('notifications:new', { notification });
  }

  /**
   * Handle mutual change notification from MutualChangeDetector
   */
  private handleMutualNotification(data: { event: NostrEvent; type: 'mutual_unfollow' | 'mutual_new' }): void {
    // Skip if from muted user (full mute OR soft mute)
    if (this.isAuthorMutedOrSoftMuted(data.event.pubkey)) {
      return;
    }

    const notification: NotificationEvent = {
      event: data.event,
      type: data.type,
      timestamp: data.event.created_at
    };

    if (!this.addNotification(notification)) return;

    const typeLabel = data.type === 'mutual_unfollow' ? 'unfollowed' : 'new mutual';
    this.systemLogger.info('NotificationsOrchestrator', `🔔 Mutual notification: ${typeLabel}`);

    this.eventBus.emit('notifications:badge-update');
    this.eventBus.emit('notifications:new', { notification });
  }

  /**
   * Handle follower change notification from the follower-notification addon's detector.
   */
  private handleFollowerNotification(data: { event: NostrEvent; type: 'follower_new' }): void {
    if (this.isAuthorMutedOrSoftMuted(data.event.pubkey)) {
      return;
    }

    const notification: NotificationEvent = {
      event: data.event,
      type: data.type,
      timestamp: data.event.created_at
    };

    if (!this.addNotification(notification)) return;

    this.systemLogger.info('NotificationsOrchestrator', '🔔 Follower notification: new follower');

    this.eventBus.emit('notifications:badge-update');
    this.eventBus.emit('notifications:new', { notification });
  }

  /**
   * Handle a community-dhikr notification from the nostr-majlis addon.
   * Anonymous by design: the synthetic event carries no real author, so there is
   * no identity to render or mute — just the action text + the Community Dhikr link.
   */
  private handleDhikrNotification(data: { event: NostrEvent; type: 'dhikr_round' | 'dhikr_commit' | 'dhikr_complete' }): void {
    const notification: NotificationEvent = {
      event: data.event,
      type: data.type,
      timestamp: data.event.created_at
    };

    if (!this.addNotification(notification)) return;

    this.systemLogger.info('NotificationsOrchestrator', 'New community dhikr activity');

    this.eventBus.emit('notifications:badge-update');
    this.eventBus.emit('notifications:new', { notification });
  }

  /**
   * Handle a Nostrord NIP-29 group activity notification from the nostrord addon.
   * The synthetic event carries no real author (activity is summarized, not attributed), so the
   * item renders anonymously; the group name travels in meta for the action text.
   */
  private handleNostrordNotification(data: { event: NostrEvent; groupName: string; mine?: boolean; groupRelay?: string }): void {
    const notification: NotificationEvent = {
      event: data.event,
      type: 'nostrord',
      timestamp: data.event.created_at,
      meta: { groupName: data.groupName, isOwn: data.mine === true, ...(data.groupRelay ? { groupRelay: data.groupRelay } : {}) }
    };

    if (!this.addNotification(notification)) return;

    this.systemLogger.info('NotificationsOrchestrator', 'New activity in a Nostrord group');

    this.eventBus.emit('notifications:badge-update');
    this.eventBus.emit('notifications:new', { notification });
  }

  /**
   * Handle hashtag notification from HashtagNotificationService
   */
  private handleHashtagNotification(data: { hashtag: string; count: number; latestEvent: NostrEvent }): void {
    // Create a notification with meta info
    // Use current time for timestamp (not event.created_at) so hashtag notifications
    // are always considered "new" when received, regardless of when the post was made
    const notification: NotificationEvent = {
      event: data.latestEvent,
      type: 'hashtag',
      timestamp: Math.floor(Date.now() / 1000),
      meta: { hashtag: data.hashtag, count: data.count }
    };

    if (!this.addNotification(notification)) return;

    this.systemLogger.info('NotificationsOrchestrator', `🏷️ Hashtag notification: ${data.count} new posts for #${data.hashtag}`);

    // Trigger callback for real-time updates (if NotificationsView is active)
    if (this.onNewNotificationCallback) {
      this.onNewNotificationCallback(notification);
    }

    this.eventBus.emit('notifications:badge-update');
  }

  /**
   * Restore mutual change notifications from storage
   * Called at startup to persist notifications across app restarts
   */
  private restoreMutualChangeNotifications(currentUserPubkey: string): void {
    const storage = MutualChangeStorage.getInstance();
    const changes = storage.getChanges();

    if (changes.length === 0) {
      this.systemLogger.info('NotificationsOrchestrator', 'No stored mutual changes to restore');
      return;
    }

    this.systemLogger.info('NotificationsOrchestrator', `Restoring ${changes.length} mutual change notifications`);

    for (const change of changes) {
      const type: NotificationType = change.type === 'unfollow' ? 'mutual_unfollow' : 'mutual_new';
      const eventId = `mutual-${type}-${change.pubkey}-${change.detectedAt}`;

      // Skip if from muted user (full mute OR soft mute)
      if (this.isAuthorMutedOrSoftMuted(change.pubkey)) {
        continue;
      }

      // Create synthetic event
      const syntheticEvent: NostrEvent = {
        id: eventId,
        pubkey: change.pubkey,
        kind: 99001,
        created_at: Math.floor(change.detectedAt / 1000),
        tags: [
          ['type', type],
          ['p', currentUserPubkey]
        ],
        content: '',
        sig: ''
      };

      const notification: NotificationEvent = {
        event: syntheticEvent,
        type,
        timestamp: syntheticEvent.created_at
      };

      this.addNotification(notification);
    }

    this.systemLogger.info('NotificationsOrchestrator', `Restored ${changes.length} mutual change notifications`);
  }

  /**
   * Restore follower change notifications from storage (persists across app restarts).
   */
  private restoreFollowerChangeNotifications(currentUserPubkey: string): void {
    const storage = FollowerSnapshotStorage.getInstance();
    const changes = storage.getChanges();

    if (changes.length === 0) {
      this.systemLogger.info('NotificationsOrchestrator', 'No stored follower changes to restore');
      return;
    }

    this.systemLogger.info('NotificationsOrchestrator', `Restoring ${changes.length} follower change notifications`);

    for (const change of changes) {
      const type: NotificationType = 'follower_new';

      if (this.isAuthorMutedOrSoftMuted(change.pubkey)) {
        continue;
      }

      const syntheticEvent: NostrEvent = {
        id: `follower-${type}-${change.pubkey}-${change.detectedAt}`,
        pubkey: change.pubkey,
        kind: 99002,
        created_at: Math.floor(change.detectedAt / 1000),
        tags: [
          ['type', type],
          ['p', currentUserPubkey]
        ],
        content: '',
        sig: ''
      };

      this.addNotification({
        event: syntheticEvent,
        type,
        timestamp: syntheticEvent.created_at
      });
    }

    this.systemLogger.info('NotificationsOrchestrator', `Restored ${changes.length} follower change notifications`);
  }

  public override destroy(): void {
    this.stop();
    super.destroy();
    this.systemLogger.info('NotificationsOrchestrator', '💀 Notifications Orchestrator destroyed');
  }
}
