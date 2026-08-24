/**
 * HamburgerBadgeManager
 * Shows a green dot on the hamburger menu when there are unread notifications or DMs
 * Only relevant in phone mode where the sidebar is hidden
 *
 * @purpose Indicate unread content when sidebar is not visible
 * @used-by MainLayout
 */

import { TypedEventBus } from '../../../core/TypedEventBus';
import { AuthService } from '../../../services/AuthService';
import { ModuleLoader } from '../../../core/ModuleLoader';
import type { NotificationsModuleApi } from '../../../modules/notifications/contracts';
import type { DMsModuleApi } from '../../../modules/dms/contracts';

export class HamburgerBadgeManager {
  private eventBus: TypedEventBus;
  private authService: AuthService;
  private dotElement: HTMLElement | null = null;
  private subscriptionIds: string[] = [];

  constructor(dotElement: HTMLElement) {
    this.dotElement = dotElement;
    this.eventBus = TypedEventBus.getInstance();
    this.authService = AuthService.getInstance();

    this.setupEventListeners();
    void this.updateDot();
  }

  private setupEventListeners(): void {
    this.subscriptionIds.push(
      this.eventBus.on('notifications:badge-update', () => this.updateDot())
    );
    this.subscriptionIds.push(
      this.eventBus.on('notifications:priorities-changed', () =>
        this.updateDot()
      )
    );
    this.subscriptionIds.push(
      this.eventBus.on('dm:fetch-complete', () => this.updateDot())
    );
    this.subscriptionIds.push(
      this.eventBus.on('dm:badge-update', () => this.updateDot())
    );
  }

  public async updateDot(): Promise<void> {
    if (!this.dotElement) return;

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.dotElement.style.display = 'none';
      return;
    }

    const ml = ModuleLoader.getInstance();
    const notifApi = ml.getApi<NotificationsModuleApi>('notifications');
    const dmsApi = ml.getApi<DMsModuleApi>('dms');

    const unreadNotifications = notifApi?.getUnreadCount() ?? 0;

    let unreadDMs = 0;
    try {
      unreadDMs = await (dmsApi?.getUnreadCount() ?? Promise.resolve(0));
    } catch {
      // Silently fail
    }

    if (unreadNotifications > 0 || unreadDMs > 0) {
      this.dotElement.style.display = 'block';
    } else {
      this.dotElement.style.display = 'none';
    }
  }

  public destroy(): void {
    this.subscriptionIds.forEach(id => this.eventBus.off(id));
    this.subscriptionIds = [];
  }
}
