/**
 * UnlockNoorSignerModal
 * Modal for entering password when trust session has expired (silent mode)
 */

import { ModalService } from '../../services/ModalService';
import { KeySignerClient } from '../../services/KeySignerClient';

export interface UnlockNoorSignerModalOptions {
  onSuccess: () => void;
  onCancel?: () => void;
}

export class UnlockNoorSignerModal {
  private modalService: ModalService;
  private keySignerClient: KeySignerClient;
  private options: UnlockNoorSignerModalOptions;
  private isSubmitting = false;

  constructor(options: UnlockNoorSignerModalOptions) {
    this.modalService = ModalService.getInstance();
    this.keySignerClient = KeySignerClient.getInstance();
    this.options = options;
  }

  public show(): void {
    const content = this.renderContent();

    this.modalService.show({
      title: 'Unlock NoorSigner',
      content,
      width: '400px',
      showCloseButton: true,
      closeOnOverlay: false,
      closeOnEsc: true,
    });

    setTimeout(() => {
      this.setupEventHandlers();
      const input = document.getElementById(
        'unlock-ns-password-input'
      ) as HTMLInputElement;
      input?.focus();
    }, 0);
  }

  private renderContent(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'keysigner-password-modal';

    container.innerHTML = `
      <div class="keysigner-password-modal__content">
        <p class="keysigner-password-modal__account">
          Your 24-hour trust session has expired. Enter your password to continue.
        </p>
        <input
          type="password"
          id="unlock-ns-password-input"
          class="input"
          placeholder="Enter NoorSigner password..."
          autocomplete="off"
        />
        <p class="keysigner-password-modal__error" id="unlock-ns-password-error" style="display: none;"></p>
        <div class="l-row l-row--end-pair">
          <button type="button" class="btn btn--passive" id="unlock-ns-cancel-btn">
            Cancel
          </button>
          <button type="button" class="btn" id="unlock-ns-submit-btn">
            Unlock
          </button>
        </div>
      </div>
    `;

    return container;
  }

  private setupEventHandlers(): void {
    const input = document.getElementById(
      'unlock-ns-password-input'
    ) as HTMLInputElement;
    const cancelBtn = document.getElementById('unlock-ns-cancel-btn');
    const submitBtn = document.getElementById('unlock-ns-submit-btn');
    const errorEl = document.getElementById('unlock-ns-password-error');

    if (!input || !cancelBtn || !submitBtn || !errorEl) return;

    const handleSubmit = async () => {
      if (this.isSubmitting) return;

      const password = input.value;
      if (!password) {
        this.showError('Please enter your password');
        return;
      }

      this.isSubmitting = true;
      submitBtn.textContent = 'Unlocking...';
      submitBtn.setAttribute('disabled', 'true');
      errorEl.style.display = 'none';

      try {
        // Daemon process is already running (started before modal appeared)
        // Submit password to it — if no process, prepare a new one first
        try {
          await this.keySignerClient.submitDaemonPassword(password);
        } catch (prepError) {
          const msg =
            prepError instanceof Error ? prepError.message : String(prepError);
          if (msg.includes('No daemon process')) {
            // Process died or wasn't prepared — restart and retry
            await this.keySignerClient.prepareDaemonForUnlock();
            await this.keySignerClient.submitDaemonPassword(password);
          } else {
            throw prepError;
          }
        }
        this.modalService.hide();
        this.options.onSuccess();
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const isPasswordError =
          errorMessage.includes('invalid_password') ||
          errorMessage.includes('Invalid password');
        this.showError(isPasswordError ? 'Incorrect password' : errorMessage);
        // Re-prepare daemon for next attempt (previous process consumed)
        this.keySignerClient.prepareDaemonForUnlock().catch(() => {});
        input.value = '';
        input.focus();
      } finally {
        this.isSubmitting = false;
        submitBtn.textContent = 'Unlock';
        submitBtn.removeAttribute('disabled');
      }
    };

    const handleCancel = () => {
      this.modalService.hide();
      this.options.onCancel?.();
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

    input.addEventListener('input', () => {
      errorEl.style.display = 'none';
    });
  }

  private showError(message: string): void {
    const errorEl = document.getElementById('unlock-ns-password-error');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = 'block';
    }
  }
}
