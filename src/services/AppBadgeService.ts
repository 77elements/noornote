/**
 * AppBadgeService
 * Manages app badge count for browser tab title and macOS dock icon
 *
 * Browser: Updates document.title with "(X) NoorNote - ..."
 * Tauri macOS: Sets dock icon badge via Tauri API
 */

import { EventBus } from './EventBus';
import { PlatformService } from './PlatformService';
import { NotificationsOrchestrator } from './orchestration/NotificationsOrchestrator';
import { DMService } from './dm/DMService';
import { AuthService } from './AuthService';

export class AppBadgeService {
  private static instance: AppBadgeService;
  private eventBus: EventBus;
  private notificationsOrch: NotificationsOrchestrator;
  private dmService: DMService;
  private authService: AuthService;
  private platform: PlatformService;
  private subscriptionIds: string[] = [];
  private originalTitle: string;
  private tauriWindow: any = null;

  private constructor() {
    this.eventBus = EventBus.getInstance();
    this.notificationsOrch = NotificationsOrchestrator.getInstance();
    this.dmService = DMService.getInstance();
    this.authService = AuthService.getInstance();
    this.platform = PlatformService.getInstance();
    this.originalTitle = document.title;

    this.initTauriWindow();
    this.setupEventListeners();

    // Initial update if user is already logged in
    if (this.authService.getCurrentUser()) {
      // Delay to allow other services to initialize
      setTimeout(() => this.updateBadge(), 1000);
    }
  }

  public static getInstance(): AppBadgeService {
    if (!AppBadgeService.instance) {
      AppBadgeService.instance = new AppBadgeService();
    }
    return AppBadgeService.instance;
  }

  /**
   * Initialize Tauri window reference for badge API
   */
  private async initTauriWindow(): Promise<void> {
    if (this.platform.isTauri && !this.platform.isAndroid) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        this.tauriWindow = getCurrentWindow();
      } catch {
        // Tauri API not available
      }
    }
  }

  /**
   * Setup event listeners for badge updates
   */
  private setupEventListeners(): void {
    // Notifications badge update
    this.subscriptionIds.push(
      this.eventBus.on('notifications:badge-update', () => this.updateBadge())
    );

    // DM badge updates
    this.subscriptionIds.push(
      this.eventBus.on('dm:badge-update', () => this.updateBadge())
    );
    this.subscriptionIds.push(
      this.eventBus.on('dm:fetch-complete', () => this.updateBadge())
    );

    // Auth state changes (login/logout)
    this.subscriptionIds.push(
      this.eventBus.on('auth:login', () => this.updateBadge())
    );
    this.subscriptionIds.push(
      this.eventBus.on('auth:logout', () => this.clearBadge())
    );
  }

  /**
   * Update badge count (browser title + Tauri dock)
   */
  public async updateBadge(): Promise<void> {
    // Only show badge if logged in
    if (!this.authService.getCurrentUser()) {
      this.clearBadge();
      return;
    }

    const notificationCount = this.notificationsOrch.getUnreadCount();
    let dmCount = 0;
    try {
      dmCount = await this.dmService.getUnreadCount();
    } catch {
      // DM count not available
    }

    const totalCount = notificationCount + dmCount;
    this.setBadgeCount(totalCount);
  }

  /**
   * Set badge count on browser title and Tauri dock
   */
  private setBadgeCount(count: number): void {
    // Browser: Update document title
    if (count > 0) {
      const displayCount = count > 99 ? '99+' : count.toString();
      document.title = `(${displayCount}) ${this.originalTitle}`;
    } else {
      document.title = this.originalTitle;
    }

    // Tauri macOS: Update dock badge
    if (this.tauriWindow) {
      this.tauriWindow.setBadgeCount(count > 0 ? count : null).catch(() => {});
    }
  }

  /**
   * Clear badge (on logout or no unread items)
   */
  private clearBadge(): void {
    document.title = this.originalTitle;
    if (this.tauriWindow) {
      this.tauriWindow.setBadgeCount(null).catch(() => {});
    }
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    this.subscriptionIds.forEach(id => this.eventBus.off(id));
    this.subscriptionIds = [];
    this.clearBadge();
  }
}

// Auto-initialize on import
AppBadgeService.getInstance();
