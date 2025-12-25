/**
 * NotificationsView Component
 * Notifications feed with tabs for filtering by type
 */

import { View } from './View';
import { NotificationsOrchestrator, type NotificationType, type NotificationEvent } from '../../services/orchestration/NotificationsOrchestrator';
import { NotificationItem } from '../notifications/NotificationItem';
import { EventBus } from '../../services/EventBus';
import { InfiniteScroll } from '../ui/InfiniteScroll';
import { UserProfileService } from '../../services/UserProfileService';
import { SystemLogger } from '../system/SystemLogger';
import { NotificationsCacheService } from '../../services/NotificationsCacheService';
import { setupTabClickHandlers, switchTab } from '../../helpers/TabsHelper';

type TabType = 'all' | 'mentions' | 'reactions' | 'zaps' | 'replies';

export class NotificationsView extends View {
  private container: HTMLElement;
  private notificationsOrch: NotificationsOrchestrator;
  private userProfileService: UserProfileService;
  private eventBus: EventBus;
  private systemLogger: SystemLogger;
  private cacheService: NotificationsCacheService;
  private activeTab: TabType = 'all';
  private notificationItems: NotificationItem[] = [];
  private infiniteScroll: InfiniteScroll;
  private currentOffset: number = 0;
  private readonly BATCH_SIZE: number = 30;
  private isLoading: boolean = false;
  private hasMoreNotifications: boolean = true;
  private loadingIndicator: HTMLElement | null = null;

  constructor() {
    super();

    this.container = document.createElement('div');
    this.container.className = 'notifications-view';
    this.notificationsOrch = NotificationsOrchestrator.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.eventBus = EventBus.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.cacheService = NotificationsCacheService.getInstance();
    this.infiniteScroll = new InfiniteScroll(() => this.handleLoadMore(), {
      loadingMessage: 'Loading more notifications...'
    });

    this.render();
    this.setupInfiniteScroll();

    // Update lastSeen timestamp (syncs both cache and orchestrator)
    this.cacheService.updateLastSeen();

    // Immediately clear badge (user is viewing notifications)
    this.eventBus.emit('notifications:badge-update');

    // Load cached notifications first (instant), then fetch new ones
    this.loadFromCacheAndFetch();

    // Listen for real-time updates
    this.notificationsOrch.onNewNotification((notification) => {
      this.handleNewNotification(notification);
    });

    // Listen for hashtag notification updates
    this.eventBus.on('hashtag:new-posts', (data: { hashtag: string; count: number; latestEvent: any }) => {
      const notification: NotificationEvent = {
        event: data.latestEvent,
        type: 'hashtag',
        timestamp: data.latestEvent.created_at,
        meta: { hashtag: data.hashtag, count: data.count }
      };
      this.handleNewNotification(notification);
    });
  }

  /**
   * Render the notifications view
   */
  private render(): void {
    this.container.innerHTML = `
      <div class="notifications-view__header">
        <h1>Notifications</h1>
      </div>
      <div id="notifications-tabs" class="tabs">
        <button class="tab tab--active" data-tab="all">All</button>
        <button class="tab" data-tab="mentions">Mentions</button>
        <button class="tab" data-tab="reactions">Reactions</button>
        <button class="tab" data-tab="zaps">Zaps</button>
        <button class="tab" data-tab="replies">Replies</button>
      </div>
      <div class="notifications-view__content">
        <div class="notifications-view__list"></div>
      </div>
    `;

    // Setup tab click handlers
    setupTabClickHandlers(this.container, (tabId) => this.switchTab(tabId as TabType));
  }

  /**
   * Setup infinite scroll
   */
  private setupInfiniteScroll(): void {
    const list = this.container.querySelector('.notifications-view__list');
    if (!list) return;

    this.infiniteScroll.observe(list as HTMLElement);
  }

  /**
   * Handle load more (infinite scroll)
   */
  private async handleLoadMore(): Promise<void> {
    if (this.isLoading || !this.hasMoreNotifications) return;

    // Log to SystemLogger when InfiniteScroll triggers (not initial load)
    const isInitialLoad = this.currentOffset === 0;
    if (!isInitialLoad) {
      this.systemLogger.info('NotificationsView', '⏳ Loading older notifications...');
    }

    await this.loadNotificationsBatch();
  }

  /**
   * Load cached notifications first (instant), then fetch new ones
   */
  private async loadFromCacheAndFetch(): Promise<void> {
    // Step 1: Load cached notifications (instant display)
    const cachedNotifications = this.cacheService.getCachedNotifications();

    if (cachedNotifications.length > 0) {
      // Feed cached events into NotificationsOrchestrator
      this.notificationsOrch.addCachedNotifications(cachedNotifications);

      // Render first batch from cache
      await this.loadNotificationsBatch();

      this.systemLogger.info('NotificationsView', `✓ Loaded ${cachedNotifications.length} cached notifications`);
    } else {
      // No cache - do initial fetch
      await this.loadNotificationsBatch();
    }

    // Step 2: Fetch new notifications since lastFetch
    const lastFetch = this.cacheService.getLastFetch();
    if (lastFetch > 0) {
      // Fetch only new notifications
      await this.notificationsOrch.fetchNewNotifications(lastFetch);

      // Get all current notifications and update cache
      const allNotifications = this.notificationsOrch.getAllNotificationEvents();
      this.cacheService.addNotifications(allNotifications);

      // Log if new notifications arrived (but don't re-render - they're already in orchestrator)
      const newCount = allNotifications.filter(e => e.created_at > lastFetch).length;
      if (newCount > 0) {
        this.systemLogger.info('NotificationsView', `✓ Fetched ${newCount} new notifications (already visible)`);
      }
    } else {
      // First time - cache what we just fetched
      const allNotifications = this.notificationsOrch.getAllNotificationEvents();
      this.cacheService.addNotifications(allNotifications);
    }

    // Update badge after fetch completes (reflects any new notifications that arrived)
    this.eventBus.emit('notifications:badge-update');
  }

  /**
   * Load a batch of notifications with pre-loaded profiles
   */
  private async loadNotificationsBatch(): Promise<void> {
    if (this.isLoading) return;

    this.isLoading = true;
    const list = this.container.querySelector('.notifications-view__list');
    if (!list) {
      this.isLoading = false;
      return;
    }

    // Show loading indicator + log based on whether this is initial load
    const isInitialLoad = this.currentOffset === 0;
    if (isInitialLoad) {
      // Initial load - show generic loading message
      this.systemLogger.info('NotificationsView', '⏳ Loading notifications...');
    }
    this.showLoadingIndicator();

    // Get notifications batch from memory
    const notificationType = this.getNotificationTypeFromTab();
    let notifications = this.notificationsOrch.getNotifications(
      notificationType,
      this.currentOffset,
      this.BATCH_SIZE
    );

    // If no notifications in memory AND we haven't loaded everything, fetch older from relays
    if (notifications.length === 0 && this.hasMoreNotifications) {
      // Log to SystemLogger (local) - fetch triggered (only if NOT initial load)
      if (!isInitialLoad) {
        this.systemLogger.info('NotificationsView', '⏳ Fetching older notifications...');
      }

      // Get oldest timestamp from current notifications
      const allNotifications = this.notificationsOrch.getNotifications();
      if (allNotifications.length > 0) {
        const oldestTimestamp = allNotifications[allNotifications.length - 1].timestamp;

        // Fetch older notifications from relays
        await this.notificationsOrch.fetchOlderNotifications(oldestTimestamp, this.BATCH_SIZE);

        // Now try getting from memory again
        notifications = this.notificationsOrch.getNotifications(
          notificationType,
          this.currentOffset,
          this.BATCH_SIZE
        );
      } else {
        // No notifications at all (first load returned nothing)
        this.hasMoreNotifications = false;
      }
    }

    // Check if we have more notifications
    const totalCount = this.notificationsOrch.getNotificationCount(notificationType);
    this.hasMoreNotifications = (this.currentOffset + notifications.length) < totalCount;

    // Show empty state if first batch and no notifications
    if (notifications.length === 0 && this.currentOffset === 0) {
      list.innerHTML = '<div class="notifications-view__empty">No notifications yet</div>';
      this.isLoading = false;
      return;
    }

    // If still no more notifications after fetch, stop
    if (notifications.length === 0) {
      this.hasMoreNotifications = false;
      this.isLoading = false;
      return;
    }

    // Extract all unique pubkeys from this batch
    const pubkeys = new Set<string>();
    notifications.forEach(notification => {
      // For zaps, extract author from P tag
      if (notification.type === 'zap') {
        const pTag = notification.event.tags.find(t => t[0] === 'P');
        if (pTag && pTag[1]) {
          pubkeys.add(pTag[1]);
        }
      } else {
        pubkeys.add(notification.event.pubkey);
      }
    });

    // Batch-fetch ALL profiles BEFORE rendering
    await this.userProfileService.getUserProfiles(Array.from(pubkeys));

    // Remove empty state if present
    const emptyState = list.querySelector('.notifications-view__empty');
    if (emptyState) {
      emptyState.remove();
    }

    // Now render notification items (profiles are already cached)
    const sentinel = list.querySelector('.infinite-scroll-sentinel');
    notifications.forEach(notification => {
      const item = new NotificationItem({
        event: notification.event,
        type: notification.type,
        timestamp: notification.timestamp
      });

      this.notificationItems.push(item);

      // Insert before sentinel (if it exists) to keep sentinel at end
      if (sentinel) {
        list.insertBefore(item.getElement(), sentinel);
      } else {
        list.appendChild(item.getElement());
      }
    });

    // Update offset for next batch
    this.currentOffset += notifications.length;

    // Hide loading indicator
    this.hideLoadingIndicator();

    this.isLoading = false;
  }

  /**
   * Show loading indicator at bottom of list
   */
  private showLoadingIndicator(): void {
    if (this.loadingIndicator) return; // Already showing

    const list = this.container.querySelector('.notifications-view__list');
    if (!list) return;

    // Determine message based on whether this is initial load
    const isInitialLoad = this.currentOffset === 0;
    const message = isInitialLoad
      ? 'Loading notifications...'
      : 'Loading older notifications...';

    this.loadingIndicator = document.createElement('div');
    this.loadingIndicator.className = 'notifications-view__loading';
    this.loadingIndicator.textContent = message;
    list.appendChild(this.loadingIndicator);
  }

  /**
   * Hide loading indicator
   */
  private hideLoadingIndicator(): void {
    if (!this.loadingIndicator) return;

    this.loadingIndicator.remove();
    this.loadingIndicator = null;
  }

  /**
   * Get notification type from active tab
   */
  private getNotificationTypeFromTab(): NotificationType | undefined {
    if (this.activeTab === 'all') {
      return undefined;
    }

    // Map tab type to notification type
    const typeMap: Record<Exclude<TabType, 'all'>, NotificationType> = {
      'mentions': 'mention',
      'reactions': 'reaction',
      'zaps': 'zap',
      'replies': 'reply'
    };

    return typeMap[this.activeTab as Exclude<TabType, 'all'>];
  }

  /**
   * Switch active tab
   */
  private switchTab(tabType: TabType): void {
    if (this.activeTab === tabType) return;

    this.activeTab = tabType;

    // Update tab UI
    switchTab(this.container, tabType);

    // Reset and reload notifications
    this.resetAndReload();
  }

  /**
   * Reset pagination state and reload first batch
   */
  private resetAndReload(): void {
    const list = this.container.querySelector('.notifications-view__list');
    if (!list) return;

    // Clear existing items
    this.notificationItems.forEach(item => item.destroy());
    this.notificationItems = [];
    list.innerHTML = '';

    // Reset pagination
    this.currentOffset = 0;
    this.hasMoreNotifications = true;

    // Load first batch
    this.loadNotificationsBatch();
  }

  /**
   * Handle new notification (real-time)
   */
  private async handleNewNotification(notification: NotificationEvent): Promise<void> {
    // Update cache with new notification
    const allNotifications = this.notificationsOrch.getAllNotificationEvents();
    this.cacheService.addNotifications(allNotifications);

    // Only add if current tab matches (or "all" tab is active)
    const shouldShow = this.activeTab === 'all' ||
      (this.activeTab === 'mentions' && notification.type === 'mention') ||
      (this.activeTab === 'reactions' && notification.type === 'reaction') ||
      (this.activeTab === 'zaps' && notification.type === 'zap') ||
      (this.activeTab === 'replies' && notification.type === 'reply');

    if (!shouldShow) return;

    const list = this.container.querySelector('.notifications-view__list');
    if (!list) return;

    // Remove empty state if present
    const emptyState = list.querySelector('.notifications-view__empty');
    if (emptyState) {
      emptyState.remove();
    }

    // Fetch profile BEFORE rendering (like batch does)
    let pubkey = notification.event.pubkey;

    // For zaps, extract author from P tag
    if (notification.type === 'zap') {
      const pTag = notification.event.tags.find(t => t[0] === 'P');
      if (pTag && pTag[1]) {
        pubkey = pTag[1];
      }
    }

    // Fetch profile (don't wait - UserProfileService will handle caching)
    await this.userProfileService.getUserProfile(pubkey);

    // Create new item and prepend (newest first)
    const item = new NotificationItem({
      event: notification.event,
      type: notification.type,
      timestamp: notification.timestamp
    });

    this.notificationItems.unshift(item);
    list.prepend(item.getElement());
  }

  /**
   * Get the element
   */
  public getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    this.infiniteScroll.destroy();
    this.notificationItems.forEach(item => item.destroy());
    this.notificationItems = [];
    this.container.remove();
  }

  /**
   * Save state (mark as read when navigating away)
   */
  public override saveState(): void {
    this.notificationsOrch.markAsRead();
  }
}
