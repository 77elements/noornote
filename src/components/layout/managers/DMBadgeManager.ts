/**
 * DMBadgeManager
 * Manages DM badge in MainLayout sidebar
 *
 * @purpose Update badge count based on unread DMs
 * @used-by MainLayout
 */

import { TypedEventBus } from '../../../core/TypedEventBus';
import { AuthService } from '../../../services/AuthService';
import { ModuleLoader } from '../../../core/ModuleLoader';
import type { DMsModuleApi } from '../../../modules/dms/contracts';

export class DMBadgeManager {
  private eventBus: TypedEventBus;
  private authService: AuthService;
  private badgeElement: HTMLElement | null = null;
  private subscriptionIds: string[] = [];

  constructor(badgeElement: HTMLElement) {
    this.badgeElement = badgeElement;
    this.eventBus = TypedEventBus.getInstance();
    this.authService = AuthService.getInstance();

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.subscriptionIds.push(
      this.eventBus.on('dm:fetch-complete', () => {
        this.updateBadgeCount();
      })
    );
    this.subscriptionIds.push(
      this.eventBus.on('dm:badge-update', () => {
        this.updateBadgeCount();
      })
    );
  }

  public async updateBadgeCount(): Promise<void> {
    if (!this.badgeElement) return;

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.badgeElement.style.display = 'none';
      return;
    }

    try {
      const dmsApi = ModuleLoader.getInstance().getApi<DMsModuleApi>('dms');
      const unreadCount = await (dmsApi?.getUnreadCount() ??
        Promise.resolve(0));

      if (unreadCount > 0) {
        this.badgeElement.textContent =
          unreadCount > 99 ? '99+' : unreadCount.toString();
        this.badgeElement.style.display = 'inline-flex';
      } else {
        this.badgeElement.style.display = 'none';
      }
    } catch {
      this.badgeElement.style.display = 'none';
    }
  }

  public destroy(): void {
    this.subscriptionIds.forEach(id => this.eventBus.off(id));
    this.subscriptionIds = [];
  }
}
