/**
 * ZapManager
 * Handles zap interactions for InteractionStatusLine:
 * - Default: Click opens Zap Modal (amount selection)
 * - Quick Zap (opt-in setting): Click sends default amount, long-press opens modal
 * - Button state updates (yellow icon, amount badge, loading spinner)
 */

import { AuthGuard } from '../../../services/AuthGuard';
import { AuthService } from '../../../services/AuthService';
import { ModuleLoader } from '../../../core/ModuleLoader';
import type { ZapsModuleApi } from '../../../modules/zaps/contracts';
import { ToastService } from '../../../services/ToastService';
import type { ReactionsModuleApi } from '../../../modules/reactions/contracts';
import { TypedEventBus } from '../../../core/TypedEventBus';
import { UserProfileService } from '../../../services/UserProfileService';
import { PerAccountLocalStorage, StorageKeys } from '../../../services/PerAccountLocalStorage';

export interface ZapManagerConfig {
  noteId: string;
  authorPubkey: string;
  onStatsUpdate?: (zaps: number) => void;
  onCustomZap?: () => void;
  /**
   * LONG-FORM ARTICLES ONLY: Event ID for addressable events
   * When zapping an article, noteId is the addressable identifier (kind:pubkey:d-tag)
   * and articleEventId is the actual event ID (hex). Both are needed for proper tagging.
   */
  articleEventId?: string;
}

export class ZapManager {
  private config: ZapManagerConfig;
  private _zapsApi?: ZapsModuleApi | null;
  private get zapsApi(): ZapsModuleApi | null {
    return this._zapsApi ??= ModuleLoader.getInstance().getApi<ZapsModuleApi>('zaps');
  }
  private authService: AuthService;
  private _reactionsApi?: ReactionsModuleApi | null;
  private get reactionsApi(): ReactionsModuleApi | null {
    return this._reactionsApi ??= ModuleLoader.getInstance().getApi<ReactionsModuleApi>('reactions');
  }
  private eventBus: TypedEventBus;
  private userProfileService: UserProfileService;
  private zapButton: HTMLElement | null = null;
  private zappedAmount: number = 0;
  private canReceiveZaps: boolean = true; // Assume true until checked
  private disabledReason: string | null = null;

  constructor(config: ZapManagerConfig) {
    this.config = config;
    this.authService = AuthService.getInstance();
    this.eventBus = TypedEventBus.getInstance();
    this.userProfileService = UserProfileService.getInstance();
  }

  /**
   * Check if Quick Zap is enabled (opt-in setting, default OFF)
   */
  private isQuickZapEnabled(): boolean {
    return PerAccountLocalStorage.getInstance().get(StorageKeys.QUICK_ZAP_ENABLED, false);
  }

  /**
   * Set zap button element reference
   */
  public setButtonElement(button: HTMLElement): void {
    this.zapButton = button;
    // Re-apply disabled state if it was determined before the button existed
    if (this.disabledReason) {
      this.disableZapButton(this.disabledReason);
    }
  }

  /**
   * Check if current user has already zapped this note
   * Uses ZapService to get zap amount from localStorage
   */
  public async checkZappedStatus(): Promise<void> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return;

      const zapAmount = this.zapsApi?.getUserZapAmount(this.config.noteId) ?? 0;

      if (zapAmount > 0) {
        this.zappedAmount = zapAmount;
        this.updateButtonState(true);
      }
    } catch (error) {
      console.warn('Failed to check zapped status:', error);
    }
  }

  /**
   * Check if recipient has Lightning wallet configured (lud16/lud06)
   * Also disables the button when the recipient is the current user (self-zap)
   */
  public async checkRecipientCanReceiveZaps(): Promise<void> {
    // Self-zap: disable immediately, no need to fetch profile
    const currentUser = this.authService.getCurrentUser();
    if (currentUser && this.config.authorPubkey === currentUser.pubkey) {
      this.canReceiveZaps = false;
      this.disableZapButton('You cannot zap your own notes');
      return;
    }

    try {
      const profile = await this.userProfileService.getUserProfile(this.config.authorPubkey);

      if (!profile || (!profile.lud16 && !profile.lud06 && !profile.nip05)) {
        this.canReceiveZaps = false;
        this.disableZapButton('This user has no Lightning wallet configured');
      }
    } catch (error) {
      // On error, leave button enabled (fail open)
      console.warn('Failed to check recipient zap capability:', error);
    }
  }

  /**
   * Disable zap button visually
   */
  private disableZapButton(reason: string): void {
    this.disabledReason = reason;
    if (!this.zapButton) return;

    this.zapButton.classList.add('disabled');
    this.zapButton.setAttribute('disabled', 'true');
    this.zapButton.title = reason;
  }

  /**
   * Handle quick zap action
   */
  public async handleQuickZap(): Promise<void> {
    if (!AuthGuard.requireAuth('zap this note')) {
      return;
    }

    if (!this.checkCanZap()) {
      return;
    }

    await this.sendQuickZap();
  }

  /**
   * Handle custom zap action (modal)
   */
  public handleCustomZap(): void {
    if (!AuthGuard.requireAuth('send custom zap')) {
      return;
    }

    if (!this.checkCanZap()) {
      return;
    }

    // Use custom handler if provided, otherwise open modal
    if (this.config.onCustomZap) {
      this.config.onCustomZap();
    } else {
      this.openCustomZapModal();
    }
  }

  /**
   * Check if user can zap this note
   */
  private checkCanZap(): boolean {
    if (!this.canReceiveZaps) {
      ToastService.show('This user has no Lightning wallet configured', 'info');
      return false;
    }

    const currentUser = this.authService.getCurrentUser();
    if (currentUser && this.config.authorPubkey === currentUser.pubkey) {
      ToastService.show('You cannot zap your own notes', 'info');
      return false;
    }
    return true;
  }

  /**
   * Send Quick Zap with default settings
   */
  private async sendQuickZap(): Promise<void> {
    try {
      this.updateButtonLoading(true);

      const result = await this.zapsApi?.sendQuickZap(
        this.config.noteId,
        this.config.authorPubkey,
        this.config.articleEventId
      ) ?? { success: false };

      this.updateButtonLoading(false);

      if (result.success) {
        const zapAmount = result.amount ?? 0;
        this.zappedAmount = this.zapsApi?.getUserZapAmount(this.config.noteId) ?? zapAmount;
        this.updateButtonState(true);

        // Clear stale cache before triggering stats refresh
        this.reactionsApi?.clearCache(this.config.noteId);

        if (this.config.onStatsUpdate && zapAmount > 0) {
          this.config.onStatsUpdate(zapAmount);
        }

        // Emit event for ZapsList refresh
        this.eventBus.emit('zap:added', { noteId: this.config.noteId });
      }
    } catch (error) {
      console.error('Failed to send zap:', error);
      this.updateButtonLoading(false);
    }
  }

  /**
   * Open Custom Zap Modal
   */
  private async openCustomZapModal(): Promise<void> {
    const { ZapModal } = await import('../../modals/ZapModal');

    const options = {
      noteId: this.config.noteId,
      authorPubkey: this.config.authorPubkey,
      onZapSent: (amount: number) => {
        this.zappedAmount = this.zapsApi?.getUserZapAmount(this.config.noteId) ?? 0;
        this.updateButtonState(true);

        // Clear stale cache before triggering stats refresh
        this.reactionsApi?.clearCache(this.config.noteId);

        if (this.config.onStatsUpdate) {
          this.config.onStatsUpdate(amount);
        }

        // Emit event for ZapsList refresh
        this.eventBus.emit('zap:added', { noteId: this.config.noteId });
      }
    };

    // Conditional property assignment for exactOptionalPropertyTypes
    if (this.config.articleEventId) {
      (options as { articleEventId?: string }).articleEventId = this.config.articleEventId;
    }

    const zapModal = new ZapModal(options);
    zapModal.show();
  }

  /**
   * Update zap button visual state (yellow icon + amount badge)
   */
  private updateButtonState(zapped: boolean): void {
    if (!this.zapButton) return;

    const zapIcon = this.zapButton.querySelector('.isl-icon');

    if (zapIcon) {
      if (zapped && this.zappedAmount > 0) {
        this.zapButton.classList.add('active', 'zapped');

        let amountBadge = this.zapButton.querySelector('.badge--warning') as HTMLElement;
        if (!amountBadge) {
          amountBadge = document.createElement('span');
          amountBadge.className = 'badge badge--warning';
          const countEl = this.zapButton.querySelector('.isl-count');
          (countEl || zapIcon).insertAdjacentElement('afterend', amountBadge);
        }
        amountBadge.textContent = this.zappedAmount.toString();
      } else {
        this.zapButton.classList.remove('active', 'zapped');

        const amountBadge = this.zapButton.querySelector('.badge--warning');
        if (amountBadge) {
          amountBadge.remove();
        }
      }
    }
  }

  /**
   * Update zap button loading state (spinner during payment)
   */
  private updateButtonLoading(loading: boolean): void {
    if (!this.zapButton) return;

    const zapIcon = this.zapButton.querySelector('.isl-icon');

    if (zapIcon) {
      if (loading) {
        this.zapButton.classList.add('loading');
        zapIcon.innerHTML = `<svg width="18" height="18"><use href="#icon-spinner"/></svg>`;
      } else {
        this.zapButton.classList.remove('loading');
        zapIcon.innerHTML = `<svg width="18" height="18"><use href="#icon-zap"/></svg>`;
      }
    }
  }

  /**
   * Attach event listeners to zap button
   * Checks Quick Zap setting dynamically at click time (not at setup time)
   * Quick Zap OFF (default): click = open modal
   * Quick Zap ON: click = quick zap, long-press = open modal
   */
  public attachEventListeners(zapButton: HTMLElement): void {
    this.setButtonElement(zapButton);

    let longPressTimer: number | null = null;
    let isLongPress = false;

    const startLongPress = () => {
      if (!this.isQuickZapEnabled()) return;
      isLongPress = false;
      longPressTimer = window.setTimeout(() => {
        isLongPress = true;
        this.handleCustomZap();
      }, 1000);
    };

    const cancelLongPress = () => {
      if (longPressTimer) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const handleRelease = () => {
      cancelLongPress();
      if (isLongPress) return;

      if (this.isQuickZapEnabled()) {
        this.handleQuickZap();
      } else {
        this.handleCustomZap();
      }
    };

    // Mouse events
    zapButton.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      startLongPress();
    });

    zapButton.addEventListener('mouseup', (e) => {
      e.stopPropagation();
      handleRelease();
    });

    zapButton.addEventListener('mouseleave', () => {
      cancelLongPress();
    });

    // Touch events
    zapButton.addEventListener('touchstart', (e) => {
      e.stopPropagation();
      startLongPress();
    });

    zapButton.addEventListener('touchend', (e) => {
      e.stopPropagation();
      handleRelease();
    });

    zapButton.addEventListener('touchcancel', () => {
      cancelLongPress();
    });
  }
}
