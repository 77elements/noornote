/**
 * HamburgerBadgeManager
 * Shows a green dot on the hamburger menu when there are unread notifications or DMs
 * Only relevant in phone mode where the sidebar is hidden
 *
 * @purpose Indicate unread content when sidebar is not visible
 * @used-by MainLayout
 */

import { EventBus } from '../../../services/EventBus';
import { NotificationsOrchestrator } from '../../../services/orchestration/NotificationsOrchestrator';
import { DMService } from '../../../services/dm/DMService';
import { AuthService } from '../../../services/AuthService';

export class HamburgerBadgeManager {
  private eventBus: EventBus;
  private notificationsOrch: NotificationsOrchestrator;
  private dmService: DMService;
  private authService: AuthService;
  private dotElement: HTMLElement | null = null;
  private subscriptionIds: string[] = [];

  constructor(dotElement: HTMLElement) {
    this.dotElement = dotElement;
    this.eventBus = EventBus.getInstance();
    this.notificationsOrch = NotificationsOrchestrator.getInstance();
    this.dmService = DMService.getInstance();
    this.authService = AuthService.getInstance();

    this.setupEventListeners();
    this.updateDot();
  }

  /**
   * Setup event listeners for badge updates
   */
  private setupEventListeners(): void {
    // Notification events
    this.subscriptionIds.push(
      this.eventBus.on('notifications:badge-update', () => this.updateDot())
    );
    this.subscriptionIds.push(
      this.eventBus.on('notifications:priorities-changed', () => this.updateDot())
    );

    // DM events
    this.subscriptionIds.push(
      this.eventBus.on('dm:fetch-complete', () => this.updateDot())
    );
    this.subscriptionIds.push(
      this.eventBus.on('dm:badge-update', () => this.updateDot())
    );
  }

  /**
   * Update dot visibility based on unread notifications or DMs
   */
  public async updateDot(): Promise<void> {
    if (!this.dotElement) return;

    // Only show if user is logged in
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.dotElement.style.display = 'none';
      return;
    }

    // Check for unread notifications
    const unreadNotifications = this.notificationsOrch.getUnreadCount();

    // Check for unread DMs
    let unreadDMs = 0;
    try {
      unreadDMs = await this.dmService.getUnreadCount();
    } catch {
      // Silently fail
    }

    // Show dot if either has unread content
    if (unreadNotifications > 0 || unreadDMs > 0) {
      this.dotElement.style.display = 'block';
    } else {
      this.dotElement.style.display = 'none';
    }
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    this.subscriptionIds.forEach(id => this.eventBus.off(id));
    this.subscriptionIds = [];
  }
}
