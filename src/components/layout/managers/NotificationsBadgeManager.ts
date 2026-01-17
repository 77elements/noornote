/**
 * NotificationsBadgeManager
 * Manages notifications badge in MainLayout sidebar
 *
 * @purpose Update badge count based on unread notifications
 * @used-by MainLayout
 */

import { EventBus } from '../../../services/EventBus';
import { NotificationsOrchestrator } from '../../../services/orchestration/NotificationsOrchestrator';
import { AuthService } from '../../../services/AuthService';

export class NotificationsBadgeManager {
  private eventBus: EventBus;
  private notificationsOrch: NotificationsOrchestrator;
  private authService: AuthService;
  private badgeElement: HTMLElement | null = null;
  private badgeUpdateSubscriptionId: string | null = null;
  private prioritiesChangedSubscriptionId: string | null = null;

  constructor(badgeElement: HTMLElement) {
    this.badgeElement = badgeElement;
    this.eventBus = EventBus.getInstance();
    this.notificationsOrch = NotificationsOrchestrator.getInstance();
    this.authService = AuthService.getInstance();

    this.setupEventListeners();
    this.updateBadgeCount();
  }

  /**
   * Setup event listeners for badge updates
   */
  private setupEventListeners(): void {
    this.badgeUpdateSubscriptionId = this.eventBus.on('notifications:badge-update', () => {
      this.updateBadgeCount();
    });

    // Also update badge when user changes priority settings
    this.prioritiesChangedSubscriptionId = this.eventBus.on('notifications:priorities-changed', () => {
      this.updateBadgeCount();
    });
  }

  /**
   * Update notifications badge with unread count
   * Shows different style based on highest priority unread notification:
   * - Priority 1: Pulsing badge (important: replies, zaps)
   * - Priority 2: Solid badge (normal: mentions, reactions)
   * - Priority 3: Hollow badge (low: hashtags)
   */
  public updateBadgeCount(): void {
    if (!this.badgeElement) return;

    // Only show badge if user is logged in
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.badgeElement.style.display = 'none';
      return;
    }

    // Use NotificationsOrchestrator for badge count (uses fetched notifications + lastSeen)
    const unreadCount = this.notificationsOrch.getUnreadCount();

    // Remove all priority classes first
    this.badgeElement.classList.remove(
      'notifications-badge--priority-high',
      'notifications-badge--hashtag-only'
    );

    if (unreadCount > 0) {
      this.badgeElement.textContent = unreadCount > 99 ? '99+' : unreadCount.toString();
      this.badgeElement.style.display = 'inline-flex';

      // Get highest priority among unread notifications
      const highestPriority = this.notificationsOrch.getHighestUnreadPriority();

      if (highestPriority === 1) {
        // Pulsing badge for high priority
        this.badgeElement.classList.add('notifications-badge--priority-high');
      } else if (highestPriority === 3) {
        // Hollow badge for low priority (hashtags only)
        this.badgeElement.classList.add('notifications-badge--hashtag-only');
      }
      // Priority 2 uses default solid badge (no extra class needed)
    } else {
      this.badgeElement.style.display = 'none';
    }
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    if (this.badgeUpdateSubscriptionId) {
      this.eventBus.off(this.badgeUpdateSubscriptionId);
      this.badgeUpdateSubscriptionId = null;
    }
    if (this.prioritiesChangedSubscriptionId) {
      this.eventBus.off(this.prioritiesChangedSubscriptionId);
      this.prioritiesChangedSubscriptionId = null;
    }
  }
}
