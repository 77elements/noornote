/**
 * ZapModal - Custom Zap UI Component
 * Modal for sending custom zaps with specified amount and comment
 * Uses ModalService for modal infrastructure
 */

import { ModalService } from '../../services/ModalService';
import { ZapService } from '../../services/ZapService';
import { NWCService } from '../../services/NWCService';
import { ToastService } from '../../services/ToastService';
import { SystemLogger } from '../system/SystemLogger';

export interface ZapModalOptions {
  /** Note ID being zapped */
  noteId: string;
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
  private zapService: ZapService;
  private nwcService: NWCService;
  private systemLogger: SystemLogger;
  private currentOptions: ZapModalOptions | null = null;
  private isSending: boolean = false;

  constructor(options: ZapModalOptions) {
    this.modalService = ModalService.getInstance();
    this.zapService = ZapService.getInstance();
    this.nwcService = NWCService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.currentOptions = options;
  }

  /**
   * Show zap modal (async to load defaults from Keychain)
   */
  public async show(): Promise<void> {
    // Check NWC connection
    if (!this.nwcService.isConnected()) {
      ToastService.show('Please connect Lightning Wallet', 'error');
      return;
    }

    const content = await this.renderContent();

    this.modalService.show({
      title: '⚡ Custom Zap',
      content,
      width: '450px',
      height: '360px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true
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

    container.innerHTML = `
      <div class="zap-modal__content">
        <div class="zap-modal__field">
          <label for="zap-amount" class="zap-modal__label">Amount (Sats)</label>
          <input
            type="number"
            id="zap-amount"
            class="input zap-modal__input"
            value="${defaults.amount}"
            min="1"
            max="1000000"
            placeholder="21"
          />
        </div>

        <div class="zap-modal__field">
          <label for="zap-comment" class="zap-modal__label">Comment (optional)</label>
          <input
            type="text"
            id="zap-comment"
            class="input zap-modal__input"
            placeholder="Great post!"
            maxlength="280"
            value="${defaults.comment}"
          />
        </div>

        <div class="zap-modal__actions">
          <button type="button" class="btn btn--passive" id="zap-cancel-btn">Cancel</button>
          <button type="button" class="btn" id="zap-send-btn">
            <span class="btn__text">Send Zap</span>
            <span class="btn__loading" style="display: none;">Sending...</span>
          </button>
        </div>
      </div>
    `;

    return container;
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    const amountInput = document.getElementById('zap-amount') as HTMLInputElement;
    const commentInput = document.getElementById('zap-comment') as HTMLInputElement;
    const cancelBtn = document.getElementById('zap-cancel-btn');
    const sendBtn = document.getElementById('zap-send-btn') as HTMLButtonElement | null;

    if (!amountInput || !commentInput || !cancelBtn || !sendBtn) {
      this.systemLogger.error('ZapModal', 'Failed to find modal elements');
      return;
    }

    // Focus amount input
    amountInput.focus();
    amountInput.select();

    // Cancel button
    cancelBtn.addEventListener('click', () => {
      this.modalService.hide();
    });

    // Send button
    sendBtn.addEventListener('click', async () => {
      await this.handleSendZap(amountInput, commentInput, sendBtn);
    });

    // Enter key in amount input moves to comment
    amountInput.addEventListener('keydown', (e) => {
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

    // Show loading state
    this.isSending = true;
    this.setLoadingState(sendBtn, true);

    try {
      // Send custom zap via ZapService
      const result = await this.zapService.sendCustomZap(
        this.currentOptions.noteId,
        this.currentOptions.authorPubkey,
        amount,
        comment,
        this.currentOptions.articleEventId
      );

      // Hide loading state
      this.isSending = false;
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
      const { KeychainStorage } = await import('../../services/KeychainStorage');
      const stored = await KeychainStorage.loadZapDefaults();
      if (stored) {
        return stored;
      }
    } catch (error) {
      this.systemLogger.warn('ZapModal', 'Failed to load zap defaults:', error);
    }

    return {
      amount: 21,
      comment: ''
    };
  }
}
