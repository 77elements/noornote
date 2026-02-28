/**
 * DMBadgeManager
 * Manages DM badge in MainLayout sidebar
 *
 * @purpose Update badge count based on unread DMs
 * @used-by MainLayout
 *
 * DMService loaded lazily to keep it out of main bundle.
 */

import { EventBus } from '../../../services/EventBus';
import { AuthService } from '../../../services/AuthService';

export class DMBadgeManager {
  private eventBus: EventBus;
  private authService: AuthService;
  private badgeElement: HTMLElement | null = null;
  private subscriptionIds: string[] = [];

  // Lazy-loaded dep
  private dmService: any = null;

  constructor(badgeElement: HTMLElement) {
    this.badgeElement = badgeElement;
    this.eventBus = EventBus.getInstance();
    this.authService = AuthService.getInstance();

    this.setupEventListeners();
    // Don't call updateBadgeCount() here - wait for dm:fetch-complete or dm:badge-update
    // This fixes the race condition where badge tried to update before DMs were loaded
  }

  /**
   * Lazy-load DMService
   */
  private async loadDeps(): Promise<void> {
    if (this.dmService) return;
    const { DMService } = await import('../../../services/dm/DMService');
    this.dmService = DMService.getInstance();
  }

  /**
   * Setup event listeners for badge updates
   */
  private setupEventListeners(): void {
    // Update badge when DM fetch completes (initial load)
    this.subscriptionIds.push(
      this.eventBus.on('dm:fetch-complete', () => {
        this.updateBadgeCount();
      })
    );

    // Update badge on explicit badge-update events (mark read/unread, new messages)
    this.subscriptionIds.push(
      this.eventBus.on('dm:badge-update', () => {
        this.updateBadgeCount();
      })
    );
  }

  /**
   * Update DM badge with unread count
   */
  public async updateBadgeCount(): Promise<void> {
    if (!this.badgeElement) return;

    // Only show badge if user is logged in
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.badgeElement.style.display = 'none';
      return;
    }

    try {
      await this.loadDeps();
      const unreadCount = await this.dmService.getUnreadCount();

      if (unreadCount > 0) {
        this.badgeElement.textContent = unreadCount > 99 ? '99+' : unreadCount.toString();
        this.badgeElement.style.display = 'inline-flex';
      } else {
        this.badgeElement.style.display = 'none';
      }
    } catch {
      // Silently fail - badge is not critical
      this.badgeElement.style.display = 'none';
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
