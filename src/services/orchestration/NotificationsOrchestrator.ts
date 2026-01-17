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
import { SystemLogger } from '../../components/system/SystemLogger';
import { AuthService } from '../AuthService';
import { EventBus } from '../EventBus';
import { decodeNip19 } from '../NostrToolsAdapter';
import { PerAccountLocalStorage, StorageKeys } from '../PerAccountLocalStorage';
import { NoteService } from '../NoteService';

export type NotificationType = 'mention' | 'reply' | 'thread-reply' | 'repost' | 'reaction' | 'zap' | 'article' | 'mutual_unfollow' | 'mutual_new' | 'hashtag';

export interface NotificationEvent {
  event: NostrEvent;
  type: NotificationType;
  timestamp: number;
  meta?: { hashtag?: string; count?: number }; // For hashtag notifications
}

export class NotificationsOrchestrator extends Orchestrator {
  private static instance: NotificationsOrchestrator;
  private transport: NostrTransport;
  private muteOrchestrator: ReturnType<typeof MuteOrchestrator.getInstance>;
  private systemLogger: SystemLogger;
  private authService: AuthService;
  private eventBus: EventBus;
  private mutedPubkeys: Set<string> = new Set();
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

  private constructor() {
    super('NotificationsOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.muteOrchestrator = MuteOrchestrator.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.authService = AuthService.getInstance();
    this.eventBus = EventBus.getInstance();
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

    // Step 3: Subscribe to new notifications (real-time)
    const now = Math.floor(Date.now() / 1000);
    const relays = await this.getReadRelays();

    // Filter 1: Direct mentions/tags (#p filter)
    const ptagFilter: NDKFilter = {
      '#p': [currentUser.pubkey],
      kinds: [1, 6, 7, 9735], // notes, reposts, reactions, zaps
      since: now // Only new events from now on
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
        kinds: [1, 7, 9735], // replies, reactions, zaps to user's events
        since: now // Only new events from now on
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

    // Listen for article notification events
    this.eventBus.on('article-notification:new', (data: { pubkey: string; articleId: string; naddr: string; title: string; createdAt: number }) => {
      this.handleNewArticleNotification(data);
    });

    // Listen for mutual change notification events
    this.eventBus.on('mutual-notification:new', (data: { event: NostrEvent; type: 'mutual_unfollow' | 'mutual_new' }) => {
      this.handleMutualNotification(data);
    });

    // Listen for hashtag notification events
    this.eventBus.on('hashtag:new-posts', (data: { hashtag: string; count: number; latestEvent: NostrEvent }) => {
      this.handleHashtagNotification(data);
    });
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
        kinds: [1, 6, 7, 9735],
        limit: 100
      };

      // Fetch #p notifications
      const ptagNotifications = await this.transport.fetch(relays, [ptagFilter]);

      this.systemLogger.info('NotificationsOrchestrator', `✅ Fetched ${ptagNotifications.length} #p notifications`);

      // Fetch #e notifications
      const userEventIds = this.getUserEventIds();
      let etagNotifications: any[] = [];
      if (userEventIds.length > 0) {
        const etagFilter: NDKFilter = {
          '#e': userEventIds,
          kinds: [1, 7, 9735],
          limit: 100
        };

        etagNotifications = await this.transport.fetch(relays, [etagFilter]);

        this.systemLogger.info('NotificationsOrchestrator', `✅ Fetched ${etagNotifications.length} #e notifications`);
      }

      // Process all fetched notifications
      const allNotifications = [...ptagNotifications, ...etagNotifications];

      allNotifications.forEach(event => {
        this.processNotificationEvent(event);
      });

      this.systemLogger.info('NotificationsOrchestrator', `📋 Total notifications loaded: ${this.notifications.length}`);

      // Emit badge update after initial notifications are loaded
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
        kinds: [1, 6, 7, 9735],
        since: since
      };

      // Fetch #p notifications
      const ptagNotifications = await this.transport.fetch(relays, [ptagFilter]);

      // Fetch #e notifications
      const userEventIds = this.getUserEventIds();
      let etagNotifications: any[] = [];
      if (userEventIds.length > 0) {
        const etagFilter: NDKFilter = {
          '#e': userEventIds,
          kinds: [1, 7, 9735],
          since: since
        };

        etagNotifications = await this.transport.fetch(relays, [etagFilter]);
      }

      // Process all fetched notifications
      const allNotifications = [...ptagNotifications, ...etagNotifications];

      allNotifications.forEach(event => {
        this.processNotificationEvent(event);
      });

      this.systemLogger.info('NotificationsOrchestrator', `✅ Loaded ${allNotifications.length} new notifications`);

      // Emit badge update after new notifications are loaded
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
    // Exclude hashtag notifications from cache - they are transient and will be
    // regenerated by polling. Caching them would lose the type/meta info.
    return this.notifications
      .filter(n => n.type !== 'hashtag')
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
        kinds: [1, 6, 7, 9735],
        until: until,
        limit: limit
      };

      // Fetch #p notifications
      const ptagNotifications = await this.transport.fetch(relays, [ptagFilter]);

      // Fetch #e notifications
      const userEventIds = this.getUserEventIds();
      let etagNotifications: any[] = [];
      if (userEventIds.length > 0) {
        const etagFilter: NDKFilter = {
          '#e': userEventIds,
          kinds: [1, 7, 9735],
          until: until,
          limit: limit
        };

        etagNotifications = await this.transport.fetch(relays, [etagFilter]);
      }

      // Process all fetched notifications
      const allNotifications = [...ptagNotifications, ...etagNotifications];
      const newNotifications: NotificationEvent[] = [];

      allNotifications.forEach(event => {
        const beforeCount = this.notifications.length;
        this.processNotificationEvent(event);
        const afterCount = this.notifications.length;

        // If notification was added, track it
        if (afterCount > beforeCount) {
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
  private processNotificationEvent(event: NostrEvent): void {
    // Skip events from the user themselves (don't show self-mentions, self-zaps, etc.)
    if (this.userPubkey && event.pubkey === this.userPubkey) {
      return;
    }

    // Skip events from muted users
    if (this.mutedPubkeys.has(event.pubkey)) {
      return;
    }

    // Skip events from muted threads (Hell Thread protection)
    if (this.isEventInMutedThread(event)) {
      return;
    }

    // Skip notifications about user's events within muted threads
    // (e.g., likes/replies to user's posts inside a muted hell thread)
    if (this.isNotificationTargetInMutedThread(event)) {
      return;
    }

    // Detect notification type
    const type = this.getNotificationType(event);

    // Create notification
    const notification: NotificationEvent = {
      event,
      type,
      timestamp: event.created_at
    };

    // Add to notifications (avoid duplicates)
    const exists = this.notifications.some(n => n.event.id === event.id);
    if (!exists) {
      this.notifications.push(notification);

      // Sort by timestamp (newest first)
      this.notifications.sort((a, b) => b.timestamp - a.timestamp);

      // Register kind 1 events in NoteService for cache reuse
      if (event.kind === 1) {
        this.noteService.registerNote(event);
      }
    }
  }

  /**
   * Fetch user's recent events and store IDs for #e filter
   */
  private async fetchAndStoreUserEvents(userPubkey: string): Promise<void> {
    try {
      const relays = await this.getReadRelays();
      const userEvents = await this.transport.fetch(relays, [{
        authors: [userPubkey],
        kinds: [1, 30023], // notes + long-form articles
        limit: 50
      }]);

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
   * Get read relays (lazy-loads RelayConfig)
   */
  private async getReadRelays(): Promise<string[]> {
    if (!this.relayConfig) {
      const { RelayConfig } = await import('../RelayConfig');
      this.relayConfig = RelayConfig.getInstance();
    }
    return this.relayConfig.getReadRelays();
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
   * Detect notification type from event
   */
  private getNotificationType(event: NostrEvent): NotificationType {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return 'mention';

    const userEventIds = this.getUserEventIds();

    if (event.kind === 1) {
      const hasUserPtag = event.tags.some(t => t[0] === 'p' && t[1] === currentUser.pubkey);
      const hasAnyEtag = event.tags.some(t => t[0] === 'e');
      const userMentionedInContent = this.isUserMentionedInContent(event.content, currentUser.pubkey);

      // Check if this is a direct reply to user's event
      // A direct reply has either:
      // 1. An 'e' tag with marker 'reply' pointing to user's event
      // 2. An 'e' tag with marker 'root' pointing to user's event AND no other 'reply' marker
      const replyTag = event.tags.find(t => t[0] === 'e' && t[3] === 'reply');
      const rootTag = event.tags.find(t => t[0] === 'e' && t[3] === 'root');
      const replyTargetId = replyTag?.[1];
      const rootTargetId = rootTag?.[1];

      const isDirectReplyToUser = (replyTargetId && userEventIds.includes(replyTargetId)) ||
                                  (rootTargetId && userEventIds.includes(rootTargetId) && !replyTag);

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

    if (event.kind === 6) return 'repost';
    if (event.kind === 7) return 'reaction';
    if (event.kind === 9735) return 'zap';

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
    // Process new notification
    const beforeCount = this.notifications.length;
    this.processNotificationEvent(event);
    const afterCount = this.notifications.length;

    // Only trigger updates if notification was actually added (not a duplicate)
    if (afterCount > beforeCount) {
      // Get the notification (it was just added)
      const notification = this.notifications.find(n => n.event.id === event.id);
      if (notification) {
        this.systemLogger.info('NotificationsOrchestrator', `🔔 New ${notification.type}: ${event.id?.slice(0, 8) ?? 'unknown'}...`);

        // Trigger callback for real-time updates
        if (this.onNewNotificationCallback) {
          this.onNewNotificationCallback(notification);
        }

        // Emit badge update event via EventBus
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
        !this.mutedPubkeys.has(n.event.pubkey) &&
        !this.isEventInMutedThread(n.event) &&
        !this.isNotificationTargetInMutedThread(n.event)
      );
    }
  }

  /**
   * Handle new article notification from ArticleNotificationService
   */
  private async handleNewArticleNotification(data: { pubkey: string; articleId: string; naddr: string; title: string; createdAt: number }): Promise<void> {
    // Skip if from muted user
    if (this.mutedPubkeys.has(data.pubkey)) {
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

    // Check for duplicates
    const isDuplicate = this.notifications.some(n => n.event.id === data.articleId);
    if (isDuplicate) {
      return;
    }

    // Add to notifications list (at the beginning for newest first)
    this.notifications.unshift(notification);

    this.systemLogger.info('NotificationsOrchestrator', `📰 New article notification: ${data.title.slice(0, 30)}...`);

    // Emit badge update
    this.eventBus.emit('notifications:badge-update');
    this.eventBus.emit('notifications:new', { notification });
  }

  /**
   * Handle mutual change notification from MutualChangeDetector
   */
  private handleMutualNotification(data: { event: NostrEvent; type: 'mutual_unfollow' | 'mutual_new' }): void {
    // Skip if from muted user
    if (this.mutedPubkeys.has(data.event.pubkey)) {
      return;
    }

    const notification: NotificationEvent = {
      event: data.event,
      type: data.type,
      timestamp: data.event.created_at
    };

    // Check for duplicates
    const isDuplicate = this.notifications.some(n => n.event.id === data.event.id);
    if (isDuplicate) {
      return;
    }

    // Add to notifications list (at the beginning for newest first)
    this.notifications.unshift(notification);

    const typeLabel = data.type === 'mutual_unfollow' ? 'unfollowed' : 'new mutual';
    this.systemLogger.info('NotificationsOrchestrator', `🔔 Mutual notification: ${typeLabel}`);

    // Emit badge update
    this.eventBus.emit('notifications:badge-update');
    this.eventBus.emit('notifications:new', { notification });
  }

  /**
   * Handle hashtag notification from HashtagNotificationService
   */
  private handleHashtagNotification(data: { hashtag: string; count: number; latestEvent: NostrEvent }): void {
    // Create a notification with meta info
    const notification: NotificationEvent = {
      event: data.latestEvent,
      type: 'hashtag',
      timestamp: data.latestEvent.created_at,
      meta: { hashtag: data.hashtag, count: data.count }
    };

    // Check for duplicates
    const isDuplicate = this.notifications.some(n =>
      n.type === 'hashtag' && n.event.id === data.latestEvent.id
    );
    if (isDuplicate) {
      return;
    }

    // Add to notifications list (at the beginning for newest first)
    this.notifications.unshift(notification);

    this.systemLogger.info('NotificationsOrchestrator', `🏷️ Hashtag notification: ${data.count} new posts for #${data.hashtag}`);

    // Trigger callback for real-time updates (if NotificationsView is active)
    if (this.onNewNotificationCallback) {
      this.onNewNotificationCallback(notification);
    }

    // Emit badge update
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

      // Skip if from muted user
      if (this.mutedPubkeys.has(change.pubkey)) {
        continue;
      }

      // Check for duplicates
      const isDuplicate = this.notifications.some(n => n.event.id === eventId);
      if (isDuplicate) {
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

      // Add to notifications list
      this.notifications.push(notification);
    }

    // Sort notifications by timestamp (newest first)
    this.notifications.sort((a, b) => b.timestamp - a.timestamp);

    this.systemLogger.info('NotificationsOrchestrator', `Restored ${changes.length} mutual change notifications`);
  }

  public override destroy(): void {
    this.stop();
    super.destroy();
    this.systemLogger.info('NotificationsOrchestrator', '💀 Notifications Orchestrator destroyed');
  }
}
