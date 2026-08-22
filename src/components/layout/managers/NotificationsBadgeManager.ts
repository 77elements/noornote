/**
 * NotificationsBadgeManager
 * Manages notifications badge in MainLayout sidebar
 *
 * @purpose Update badge count based on unread notifications
 * @used-by MainLayout
 *
 * NotificationsOrchestrator loaded lazily to keep it out of main bundle.
 */

import { TypedEventBus } from '../../../core/TypedEventBus';
import { AuthService } from '../../../services/AuthService';
import { ModuleLoader } from '../../../core/ModuleLoader';
import type { NotificationsModuleApi } from '../../../modules/notifications/contracts';

export class NotificationsBadgeManager {
  private eventBus: TypedEventBus;
  private authService: AuthService;
  private badgeElement: HTMLElement | null = null;
  private badgeUpdateSubscriptionId: string | null = null;
  private prioritiesChangedSubscriptionId: string | null = null;

  private _notificationsApi?: NotificationsModuleApi | null;
  private get notificationsApi(): NotificationsModuleApi | null {
    return (this._notificationsApi ??=
      ModuleLoader.getInstance().getApi<NotificationsModuleApi>(
        'notifications'
      ));
  }

  constructor(badgeElement: HTMLElement) {
    this.badgeElement = badgeElement;
    this.eventBus = TypedEventBus.getInstance();
    this.authService = AuthService.getInstance();

    this.setupEventListeners();
    this.updateBadgeCount();
  }

  /**
   * Setup event listeners for badge updates
   */
  private setupEventListeners(): void {
    this.badgeUpdateSubscriptionId = this.eventBus.on(
      'notifications:badge-update',
      () => {
        this.updateBadgeCount();
      }
    );

    // Also update badge when user changes priority settings
    this.prioritiesChangedSubscriptionId = this.eventBus.on(
      'notifications:priorities-changed',
      () => {
        this.updateBadgeCount();
      }
    );
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

    if (!this.notificationsApi) return;

    const unreadCount = this.notificationsApi.getUnreadCount();

    this.badgeElement.classList.remove(
      'notifications-badge--priority-high',
      'notifications-badge--hashtag-only'
    );

    if (unreadCount > 0) {
      this.badgeElement.textContent =
        unreadCount > 99 ? '99+' : unreadCount.toString();
      this.badgeElement.style.display = 'inline-flex';

      const highestPriority = this.notificationsApi.getHighestUnreadPriority();

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
