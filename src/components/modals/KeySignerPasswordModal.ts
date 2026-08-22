/**
 * KeySignerPasswordModal
 * Modal for entering password when switching NoorSigner accounts
 */

import { ModalService } from '../../services/ModalService';
import { KeySignerClient } from '../../services/KeySignerClient';

export interface KeySignerPasswordModalOptions {
  npub: string;
  displayName?: string;
  onSuccess: (result: { pubkey: string; npub: string }) => void;
  onCancel?: () => void;
}

export class KeySignerPasswordModal {
  private modalService: ModalService;
  private keySignerClient: KeySignerClient;
  private options: KeySignerPasswordModalOptions;
  private isSubmitting: boolean = false;

  constructor(options: KeySignerPasswordModalOptions) {
    this.modalService = ModalService.getInstance();
    this.keySignerClient = KeySignerClient.getInstance();
    this.options = options;
  }

  public show(): void {
    const content = this.renderContent();

    this.modalService.show({
      title: 'Enter Password',
      content,
      width: '400px',
      showCloseButton: true,
      closeOnOverlay: false,
      closeOnEsc: true,
    });

    setTimeout(() => {
      this.setupEventHandlers();
      const input = document.getElementById(
        'keysigner-password-input'
      ) as HTMLInputElement;
      input?.focus();
    }, 0);
  }

  private renderContent(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'keysigner-password-modal';

    const displayName =
      this.options.displayName || `${this.options.npub.slice(0, 20)}...`;

    container.innerHTML = `
      <div class="keysigner-password-modal__content">
        <p class="keysigner-password-modal__account">
          Switching to: <strong>${displayName}</strong>
        </p>
        <input
          type="password"
          id="keysigner-password-input"
          class="input"
          placeholder="Enter NoorSigner password..."
          autocomplete="off"
        />
        <p class="keysigner-password-modal__error" id="keysigner-password-error" style="display: none;"></p>
        <div class="l-row l-row--end-pair">
          <button type="button" class="btn btn--passive" id="keysigner-password-cancel-btn">
            Cancel
          </button>
          <button type="button" class="btn" id="keysigner-password-submit-btn">
            Switch Account
          </button>
        </div>
      </div>
    `;

    return container;
  }

  private setupEventHandlers(): void {
    const input = document.getElementById(
      'keysigner-password-input'
    ) as HTMLInputElement;
    const cancelBtn = document.getElementById('keysigner-password-cancel-btn');
    const submitBtn = document.getElementById('keysigner-password-submit-btn');
    const errorEl = document.getElementById('keysigner-password-error');

    if (!input || !cancelBtn || !submitBtn || !errorEl) return;

    const handleSubmit = async () => {
      if (this.isSubmitting) return;

      const password = input.value;
      if (!password) {
        this.showError('Please enter your password');
        return;
      }

      this.isSubmitting = true;
      submitBtn.textContent = 'Switching...';
      submitBtn.setAttribute('disabled', 'true');
      errorEl.style.display = 'none';

      try {
        const result = await this.keySignerClient.switchAccount(
          this.options.npub,
          password
        );
        this.modalService.hide();
        this.options.onSuccess(result);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        // NoorSigner returns various error messages for wrong password
        const isPasswordError =
          errorMessage.includes('invalid password') ||
          errorMessage.includes('corrupted') ||
          errorMessage.includes('decrypt');
        this.showError(isPasswordError ? 'Incorrect password' : errorMessage);
        input.value = '';
        input.focus();
      } finally {
        this.isSubmitting = false;
        submitBtn.textContent = 'Switch Account';
        submitBtn.removeAttribute('disabled');
      }
    };

    const handleCancel = () => {
      this.modalService.hide();
      if (this.options.onCancel) {
        this.options.onCancel();
      }
    };

    cancelBtn.addEventListener('click', handleCancel);
    submitBtn.addEventListener('click', handleSubmit);

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        handleSubmit();
      } else if (e.key === 'Escape') {
        handleCancel();
      }
    });

    // Clear error when typing
    input.addEventListener('input', () => {
      errorEl.style.display = 'none';
    });
  }

  private showError(message: string): void {
    const errorEl = document.getElementById('keysigner-password-error');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = 'block';
    }
  }
}
