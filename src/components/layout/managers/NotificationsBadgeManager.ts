/**
 * NotificationsBadgeManager
 * Manages notifications badge in MainLayout sidebar
 *
 * @purpose Update badge count based on unread notifications
 * @used-by MainLayout
 *
 * NotificationsOrchestrator loaded lazily to keep it out of main bundle.
 */

import { EventBus } from '../../../services/EventBus';
import { AuthService } from '../../../services/AuthService';
import { ModuleLoader } from '../../../core/ModuleLoader';
import type { NotificationsModuleApi } from '../../../modules/notifications/contracts';

export class NotificationsBadgeManager {
  private eventBus: EventBus;
  private authService: AuthService;
  private badgeElement: HTMLElement | null = null;
  private badgeUpdateSubscriptionId: string | null = null;
  private prioritiesChangedSubscriptionId: string | null = null;

  private notificationsApi: NotificationsModuleApi | null = null;

  constructor(badgeElement: HTMLElement) {
    this.badgeElement = badgeElement;
    this.eventBus = EventBus.getInstance();
    this.authService = AuthService.getInstance();

    this.setupEventListeners();
    this.updateBadgeCount();
  }

  private loadApi(): NotificationsModuleApi | null {
    if (!this.notificationsApi) {
      this.notificationsApi = ModuleLoader.getInstance().getApi<NotificationsModuleApi>('notifications');
    }
    return this.notificationsApi;
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

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.badgeElement.style.display = 'none';
      return;
    }

    const api = this.loadApi();
    if (!api) return;

    const unreadCount = api.getUnreadCount();

    this.badgeElement.classList.remove(
      'notifications-badge--priority-high',
      'notifications-badge--hashtag-only'
    );

    if (unreadCount > 0) {
      this.badgeElement.textContent = unreadCount > 99 ? '99+' : unreadCount.toString();
      this.badgeElement.style.display = 'inline-flex';

      const highestPriority = api.getHighestUnreadPriority();

      if (highestPriority === 1) {
        this.badgeElement.classList.add('notifications-badge--priority-high');
      } else if (highestPriority === 3) {
        this.badgeElement.classList.add('notifications-badge--hashtag-only');
      }
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
