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
import { DMToastNotifier } from '../../../services/dm/DMToastNotifier';
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
    // Paint the current state immediately — the constructor runs on boot and
    // on nav-mode switches, before the first DM event fires.
    void this.updateBadgeCount();
  }

  private setupEventListeners(): void {
    this.subscriptionIds.push(
      this.eventBus.on('dm:fetch-complete', () => {
        void this.updateBadgeCount();
      })
    );
    this.subscriptionIds.push(
      this.eventBus.on('dm:badge-update', () => {
        void this.updateBadgeCount();
      })
    );
  }

  public async updateBadgeCount(): Promise<void> {
    if (!this.badgeElement) return;

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.hide();
      return;
    }

    try {
      const dmsApi = ModuleLoader.getInstance().getApi<DMsModuleApi>('dms');
      const counts = await (dmsApi?.getUnreadCountsSplit() ??
        Promise.resolve({ known: 0, unknown: 0, total: 0 }));

      // Only Known unread shows as a number. Unknown-only unread surfaces as
      // the low-key "SP" hint — deliberately not numeric, a spam wave must
      // not inflate the counter. While the spam-mode shield is up, unknown-DM
      // signals are muted entirely: no toast, no "SP" hint.
      const spamMuted = DMToastNotifier.isSpamModeActive();
      if (counts.known > 0) {
        this.badgeElement.textContent =
          counts.known > 99 ? '99+' : counts.known.toString();
        this.badgeElement.classList.remove('dm-badge--spam');
        this.show();
      } else if (counts.unknown > 0 && !spamMuted) {
        this.badgeElement.textContent = 'SP'; // i18n-ok — language-neutral abbreviation, like the 99+ cap
        this.badgeElement.classList.add('dm-badge--spam');
        this.show();
      } else {
        this.hide();
      }
    } catch {
      this.hide();
    }
  }

  private show(): void {
    if (this.badgeElement) this.badgeElement.style.display = 'inline-flex';
  }

  private hide(): void {
    if (this.badgeElement) this.badgeElement.style.display = 'none';
  }

  public destroy(): void {
    this.subscriptionIds.forEach(id => this.eventBus.off(id));
    this.subscriptionIds = [];
  }
}
