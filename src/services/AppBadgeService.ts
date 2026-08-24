/**
 * AppBadgeService
 * Manages app badge count for browser tab title and macOS dock icon
 *
 * Browser: Updates document.title with "(X) NoorNote - ..."
 * Electron macOS: Sets dock icon badge via Electron API
 *
 * Heavy deps (NotificationsOrchestrator, DMService) loaded lazily
 * to keep them out of the main bundle entry path.
 */

import { TypedEventBus } from '../core/TypedEventBus';
import { PlatformService } from './PlatformService';
import { AuthService } from './AuthService';
import { ModuleLoader } from '../core/ModuleLoader';
import type { NotificationsModuleApi } from '../modules/notifications/contracts';
import type { DMsModuleApi } from '../modules/dms/contracts';

export class AppBadgeService {
  private static instance: AppBadgeService;
  private eventBus: TypedEventBus;
  private authService: AuthService;
  private platform: PlatformService;
  private subscriptionIds: string[] = [];
  private originalTitle: string;
  private badgeApi: any = null;

  private constructor() {
    this.eventBus = TypedEventBus.getInstance();
    this.authService = AuthService.getInstance();
    this.platform = PlatformService.getInstance();
    this.originalTitle = document.title;

    void this.initBadgeApi();
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
   * Initialize badge API (Electron only)
   */
  private async initBadgeApi(): Promise<void> {
    if (!this.platform.isDesktop) return;

    if (this.platform.isElectron) {
      this.badgeApi = {
        setBadgeCount: (count: number | null) =>
          window.electronAPI!.setBadgeCount(count ?? 0),
      };
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
  }

  /**
   * Update badge count (browser title + Electron dock)
   */
  public async updateBadge(): Promise<void> {
    // Only show badge if logged in
    if (!this.authService.getCurrentUser()) {
      this.clearBadge();
      return;
    }

    const ml = ModuleLoader.getInstance();
    const notifApi = ml.getApi<NotificationsModuleApi>('notifications');
    const dmsApi = ml.getApi<DMsModuleApi>('dms');

    const notificationCount = notifApi?.getUnreadCount() ?? 0;
    let dmCount = 0;
    try {
      dmCount = await (dmsApi?.getUnreadCount() ?? Promise.resolve(0));
    } catch {
      // DM count not available
    }

    const totalCount = notificationCount + dmCount;
    this.setBadgeCount(totalCount);
  }

  /**
   * Set badge count on browser title and Electron dock
   */
  private setBadgeCount(count: number): void {
    // Browser: Update document title
    if (count > 0) {
      const displayCount = count > 99 ? '99+' : count.toString();
      document.title = `(${displayCount}) ${this.originalTitle}`;
    } else {
      document.title = this.originalTitle;
    }

    // Electron macOS: Update dock badge
    if (this.badgeApi) {
      this.badgeApi.setBadgeCount(count > 0 ? count : null).catch(() => {});
    }
  }

  /**
   * Clear badge (on logout or no unread items)
   */
  private clearBadge(): void {
    document.title = this.originalTitle;
    if (this.badgeApi) {
      this.badgeApi.setBadgeCount(null).catch(() => {});
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
