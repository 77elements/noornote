/**
 * ZapModal - Custom Zap UI Component
 * Modal for sending zaps with preset amounts or custom input
 * Uses ModalService for modal infrastructure
 */

import { ModalService } from '../../services/ModalService';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { ZapsModuleApi } from '../../modules/zaps/contracts';
import { NWCService } from '../../services/NWCService';
import { ToastService } from '../../services/ToastService';
import { PlatformService } from '../../services/PlatformService';
import { SystemLogger } from '../../services/SystemLogger';
import { Switch } from '../ui/Switch';

const PRESET_AMOUNTS = [
  { display: '21', value: 21 },
  { display: '42', value: 42 },
  { display: '210', value: 210 },
  { display: '420', value: 420 },
  { display: '1k', value: 1000 },
  { display: '2.1k', value: 2100 },
  { display: '4.2k', value: 4200 },
  { display: '10k', value: 10000 },
  { display: '21k', value: 21000 },
];

export interface ZapModalOptions {
  /** Note ID being zapped (omit for profile zaps) */
  noteId?: string;
  /** Author pubkey receiving the zap */
  authorPubkey: string;
  /** Callback when zap is successfully sent */
  onZapSent?: (amount: number) => void;
  /**
   * LONG-FORM ARTICLES ONLY: Event ID for addressable events
   * When zapping an article, noteId is the addressable identifier (kind:pubkey:d-tag)
   * and articleEventId is the actual event ID (hex). Both are needed for proper tagging.
   */
  articleEventId?: string;
}

export class ZapModal {
  private modalService: ModalService;
  private _zapsApi?: ZapsModuleApi | null;
  private get zapsApi(): ZapsModuleApi | null {
    return (this._zapsApi ??=
      ModuleLoader.getInstance().getApi<ZapsModuleApi>('zaps'));
  }
  private nwcService: NWCService;
  private systemLogger: SystemLogger;
  private currentOptions: ZapModalOptions | null = null;
  private isSending: boolean = false;
  private isAnonymous: boolean = false;
  private silentSwitch: Switch | null = null;

  constructor(options: ZapModalOptions) {
    this.modalService = ModalService.getInstance();
    this.nwcService = NWCService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.currentOptions = options;
  }

  /**
   * Show zap modal (async to load defaults from Keychain)
   */
  public async show(): Promise<void> {
    // Check if any payment method is available (NWC or WebLN in browser)
    const hasWebLN = PlatformService.getInstance().isBrowser && !!window.webln;
    if (!this.nwcService.isConnected() && !hasWebLN) {
      ToastService.show('Please connect Lightning Wallet', 'error');
      return;
    }

    const content = await this.renderContent();

    this.modalService.show({
      title: 'Zap',
      content,
      width: '450px',
      height: 'auto',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true,
    });

    // Setup event handlers after modal is shown
    setTimeout(() => {
      this.setupEventHandlers();
    }, 0);
  }

  /**
   * Render modal content (async to load defaults from Keychain)
   */
  private async renderContent(): Promise<HTMLElement> {
    const container = document.createElement('div');
    container.className = 'zap-modal';

    // Get default values from Keychain/localStorage
    const defaults = await this.getZapDefaults();

    const presetButtonsHtml = PRESET_AMOUNTS.map(
      p =>
        `<button type="button" class="btn btn--mini zap-modal__preset${p.value === defaults.amount ? ' zap-modal__preset--active' : ''}" data-amount="${p.value}">${p.display}</button>`
    ).join('');

    // Silent Zap switch: throwaway-key Anonymous mode. Always available — works
    // with every signer (NIP-07/46/55/nsec) and every zap target (note/profile/article).
    this.silentSwitch = new Switch({
      label: 'Silent Zap',
      checked: false,
      id: 'zap-silent-switch',
      onChange: checked => {
        this.isAnonymous = checked;
      },
    });

    container.innerHTML = `
      <div class="zap-modal__content">
        <div class="zap-modal__amount-display">
          <input
            type="number"
            id="zap-amount"
            class="zap-modal__amount-input"
            value="${defaults.amount}"
            min="1"
            max="1000000"
          />
          <span class="zap-modal__amount-unit">sats</span>
        </div>

        <div class="zap-modal__presets">
          ${presetButtonsHtml}
        </div>

        <div class="zap-modal__field">
          <input
            type="text"
            id="zap-comment"
            class="input zap-modal__input"
            placeholder="Comment (optional)"
            maxlength="280"
            value="${defaults.comment}"
          />
        </div>

        <div class="l-row--split zap-modal__bottom">
          <div class="zap-modal__silent">
            ${this.silentSwitch.render()}
          </div>
          <div class="zap-modal__buttons">
            <button type="button" class="btn btn--passive" id="zap-cancel-btn">Cancel</button>
            <button type="button" class="btn" id="zap-send-btn">
              <span class="btn__text">Zap</span>
              <span class="btn__loading" style="display: none;">Sending...</span>
            </button>
          </div>
        </div>
      </div>
    `;

    return container;
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    const amountInput = document.getElementById(
      'zap-amount'
    ) as HTMLInputElement;
    const commentInput = document.getElementById(
      'zap-comment'
    ) as HTMLInputElement;
    const cancelBtn = document.getElementById('zap-cancel-btn');
    const sendBtn = document.getElementById(
      'zap-send-btn'
    ) as HTMLButtonElement | null;

    if (!amountInput || !commentInput || !cancelBtn || !sendBtn) {
      this.systemLogger.error('ZapModal', 'Failed to find modal elements');
      return;
    }

    // Wire up the Silent Zap switch (must run after innerHTML is mounted).
    if (this.silentSwitch) {
      this.silentSwitch.setupEventListeners(document.body);
    }

    // Focus amount input
    amountInput.focus();
    amountInput.select();

    // Preset buttons
    const presetButtons = document.querySelectorAll('.zap-modal__preset');
    presetButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const amount = (btn as HTMLElement).dataset.amount;
        if (amount) {
          amountInput.value = amount;
          // Update active state
          presetButtons.forEach(b =>
            b.classList.remove('zap-modal__preset--active')
          );
          btn.classList.add('zap-modal__preset--active');
        }
      });
    });

    // Deselect presets when typing custom amount
    amountInput.addEventListener('input', () => {
      const val = parseInt(amountInput.value, 10);
      presetButtons.forEach(btn => {
        const presetVal = parseInt(
          (btn as HTMLElement).dataset.amount || '0',
          10
        );
        btn.classList.toggle('zap-modal__preset--active', presetVal === val);
      });
    });

    // Cancel button
    cancelBtn.addEventListener('click', () => {
      this.modalService.hide();
    });

    // Send button
    sendBtn.addEventListener('click', async () => {
      await this.handleSendZap(amountInput, commentInput, sendBtn);
    });

    // Enter key in amount input moves to comment
    amountInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commentInput.focus();
      }
    });

    // Ctrl/Cmd + Enter to send
    const handleCtrlEnter = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.handleSendZap(amountInput, commentInput, sendBtn);
      }
    };

    amountInput.addEventListener('keydown', handleCtrlEnter);
    commentInput.addEventListener('keydown', handleCtrlEnter);

    // Enter in comment field sends zap
    commentInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this.handleSendZap(amountInput, commentInput, sendBtn);
      }
    });
  }

  /**
   * Handle send zap
   */
  private async handleSendZap(
    amountInput: HTMLInputElement,
    commentInput: HTMLInputElement,
    sendBtn: HTMLButtonElement
  ): Promise<void> {
    if (!this.currentOptions) return;

    // Prevent double-send
    if (this.isSending) return;

    const amount = parseInt(amountInput.value, 10);
    const comment = commentInput.value.trim();

    // Validate amount
    if (!amount || amount < 1) {
      ToastService.show('Please enter a valid amount (min. 1 Sat)', 'error');
      amountInput.focus();
      return;
    }

    if (amount > 1000000) {
      ToastService.show('Maximum 1,000,000 Sats per zap', 'error');
      amountInput.focus();
      return;
    }

    // Show loading state — disable button immediately to prevent double-tap
    this.isSending = true;
    sendBtn.disabled = true;
    sendBtn.classList.add('btn--sending');
    this.setLoadingState(sendBtn, true);

    try {
      // Send custom zap via ZapService
      const result = (await this.zapsApi?.sendCustomZap(
        this.currentOptions.noteId,
        this.currentOptions.authorPubkey,
        amount,
        comment,
        this.currentOptions.articleEventId,
        this.isAnonymous
      )) ?? { success: false };

      this.isSending = false;
      sendBtn.disabled = false;
      sendBtn.classList.remove('btn--sending');
      this.setLoadingState(sendBtn, false);

      if (result.success) {
        // Close modal
        this.modalService.hide();

        // Call callback
        if (this.currentOptions.onZapSent) {
          this.currentOptions.onZapSent(amount);
        }
      }
      // Note: Error toast already shown by ZapService, don't show duplicate
    } catch (error) {
      this.systemLogger.error('ZapModal', 'Failed to send zap:', error);
      this.isSending = false;
      sendBtn.disabled = false;
      sendBtn.classList.remove('btn--sending');
      this.setLoadingState(sendBtn, false);
      // Error toast already shown by ZapService via ErrorService
    }
  }

  /**
   * Set loading state on send button
   */
  private setLoadingState(btn: HTMLButtonElement, loading: boolean): void {
    const btnText = btn.querySelector('.btn__text') as HTMLElement;
    const btnLoading = btn.querySelector('.btn__loading') as HTMLElement;

    if (btnText && btnLoading) {
      if (loading) {
        btnText.style.display = 'none';
        btnLoading.style.display = 'inline';
        btn.disabled = true;
      } else {
        btnText.style.display = 'inline';
        btnLoading.style.display = 'none';
        btn.disabled = false;
      }
    }
  }

  /**
   * Get zap defaults from Keychain/localStorage
   */
  private async getZapDefaults(): Promise<{ amount: number; comment: string }> {
    try {
      const { KeychainStorage } = await import(
        '../../services/KeychainStorage'
      );
      const stored = await KeychainStorage.loadZapDefaults();
      if (stored) {
        return stored;
      }
    } catch (error) {
      this.systemLogger.warn('ZapModal', 'Failed to load zap defaults:', error);
    }

    return {
      amount: 21,
      comment: '',
    };
  }
}
