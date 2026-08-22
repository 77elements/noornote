/**
 * ImportToNoorSignerModal
 * Modal for importing newly generated key into NoorSigner during onboarding
 */

import { ModalService } from '../../services/ModalService';
import { KeySignerClient } from '../../services/KeySignerClient';
import { ToastService } from '../../services/ToastService';

export interface ImportToNoorSignerModalOptions {
  nsec: string;
  npub: string;
  showNsecInput?: boolean;
  onSuccess: (result: { pubkey: string; npub: string }) => void;
  onCancel?: () => void;
}

export class ImportToNoorSignerModal {
  private modalService: ModalService;
  private keySignerClient: KeySignerClient;
  private options: ImportToNoorSignerModalOptions;
  private isSubmitting: boolean = false;

  constructor(options: ImportToNoorSignerModalOptions) {
    this.modalService = ModalService.getInstance();
    this.keySignerClient = KeySignerClient.getInstance();
    this.options = options;
  }

  public show(): void {
    const content = this.renderContent();

    this.modalService.show({
      title: 'Secure Your Key',
      content,
      width: '450px',
      showCloseButton: true,
      closeOnOverlay: false,
      closeOnEsc: true,
    });

    setTimeout(() => {
      this.setupEventHandlers();
      const focusTarget = this.options.showNsecInput
        ? document.getElementById('import-nsec-input')
        : document.getElementById('import-password-input');
      (focusTarget as HTMLInputElement)?.focus();
    }, 0);
  }

  private renderContent(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'import-noorsigner-modal';

    container.innerHTML = `
      <div class="import-noorsigner-modal__content">
        <p class="import-noorsigner-modal__intro">
          NoorSigner will securely store your private key with password encryption.
          You'll use this password to unlock your account.
        </p>

        ${
          this.options.showNsecInput
            ? `
        <div class="import-noorsigner-modal__field">
          <label for="import-nsec-input">Private Key (nsec)</label>
          <input
            type="password"
            id="import-nsec-input"
            class="input"
            placeholder="nsec1..."
            autocomplete="off"
          />
        </div>
        `
            : ''
        }

        <div class="import-noorsigner-modal__field">
          <label for="import-password-input">Password (min. 8 characters)</label>
          <input
            type="password"
            id="import-password-input"
            class="input"
            placeholder="Enter password..."
            autocomplete="new-password"
          />
        </div>

        <div class="import-noorsigner-modal__field">
          <label for="import-password-confirm">Confirm Password</label>
          <input
            type="password"
            id="import-password-confirm"
            class="input"
            placeholder="Confirm password..."
            autocomplete="new-password"
          />
        </div>

        <p class="import-noorsigner-modal__error" id="import-password-error" style="display: none;"></p>

        <div class="import-noorsigner-modal__actions">
          <button type="button" class="btn btn--passive" id="import-password-cancel-btn">
            Cancel
          </button>
          <button type="button" class="btn" id="import-password-submit-btn">
            Set Password
          </button>
        </div>
      </div>
    `;

    return container;
  }

  private setupEventHandlers(): void {
    const nsecInput = document.getElementById(
      'import-nsec-input'
    ) as HTMLInputElement | null;
    const passwordInput = document.getElementById(
      'import-password-input'
    ) as HTMLInputElement;
    const confirmInput = document.getElementById(
      'import-password-confirm'
    ) as HTMLInputElement;
    const cancelBtn = document.getElementById('import-password-cancel-btn');
    const submitBtn = document.getElementById('import-password-submit-btn');
    const errorEl = document.getElementById('import-password-error');

    if (!passwordInput || !confirmInput || !cancelBtn || !submitBtn || !errorEl)
      return;

    const handleSubmit = async () => {
      if (this.isSubmitting) return;

      // Get nsec: from input field or from options
      const nsec = this.options.showNsecInput
        ? nsecInput?.value?.trim() || ''
        : this.options.nsec;
      const password = passwordInput.value;
      const confirm = confirmInput.value;

      // Validate nsec if user input
      if (this.options.showNsecInput) {
        if (!nsec) {
          this.showError('Please enter your private key (nsec)');
          nsecInput?.focus();
          return;
        }
        if (!nsec.startsWith('nsec1')) {
          this.showError('Invalid format — must start with nsec1');
          nsecInput?.focus();
          return;
        }
      }

      // Validate password
      if (!password) {
        this.showError('Please enter a password');
        passwordInput.focus();
        return;
      }

      if (password.length < 8) {
        this.showError('Password must be at least 8 characters');
        passwordInput.focus();
        return;
      }

      if (password !== confirm) {
        this.showError('Passwords do not match');
        confirmInput.value = '';
        confirmInput.focus();
        return;
      }

      this.isSubmitting = true;
      submitBtn.textContent = 'Importing...';
      submitBtn.setAttribute('disabled', 'true');
      errorEl.style.display = 'none';

      try {
        // Check if daemon is running
        const daemonRunning = await this.keySignerClient.isRunning();
        let result: { pubkey: string; npub: string };

        if (daemonRunning) {
          // Daemon running - use API to add, then switch in-memory key
          result = await this.keySignerClient.addAccount(
            nsec,
            password,
            true // setActive on disk
          );
          await this.keySignerClient.switchAccount(result.npub, password);
        } else {
          // Daemon not running - use CLI
          result = await this.keySignerClient.addAccountViaCli(nsec, password);

          // Start daemon silently after adding account
          try {
            await window.electronAPI!.launchDaemonSilent();
          } catch (daemonError) {
            console.error('Failed to start daemon:', daemonError);
          }
        }

        this.modalService.hide();
        ToastService.show('Key successfully imported to NoorSigner', 'success');
        this.options.onSuccess(result);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error('Import failed:', errorMessage);

        if (errorMessage.includes('account already exists')) {
          this.showError('This account already exists in NoorSigner');
        } else {
          this.showError(`Import failed: ${errorMessage}`);
        }
      } finally {
        this.isSubmitting = false;
        submitBtn.textContent = 'Set Password';
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

    confirmInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        handleSubmit();
      } else if (e.key === 'Escape') {
        handleCancel();
      }
    });

    passwordInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        confirmInput.focus();
      } else if (e.key === 'Escape') {
        handleCancel();
      }
    });

    if (nsecInput) {
      nsecInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          passwordInput.focus();
        } else if (e.key === 'Escape') {
          handleCancel();
        }
      });
    }

    // Clear error when typing
    const clearError = () => {
      errorEl.style.display = 'none';
    };
    nsecInput?.addEventListener('input', clearError);
    passwordInput.addEventListener('input', clearError);
    confirmInput.addEventListener('input', clearError);
  }

  private showError(message: string): void {
    const errorEl = document.getElementById('import-password-error');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = 'block';
    }
  }
}
