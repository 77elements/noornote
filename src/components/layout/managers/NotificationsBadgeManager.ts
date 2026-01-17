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
  }

  /**
   * Update notifications badge with unread count
   * Shows different style for hashtag-only notifications (less important)
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

    if (unreadCount > 0) {
      this.badgeElement.textContent = unreadCount > 99 ? '99+' : unreadCount.toString();
      this.badgeElement.style.display = 'inline-flex';

      // Check if all unread are hashtag-only (lower priority indicator)
      const hashtagOnly = this.notificationsOrch.hasOnlyHashtagUnread();
      this.badgeElement.classList.toggle('notifications-badge--hashtag-only', hashtagOnly);
    } else {
      this.badgeElement.style.display = 'none';
      this.badgeElement.classList.remove('notifications-badge--hashtag-only');
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
  }
}
