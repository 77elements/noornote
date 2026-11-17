/**
 * KeySignerPasswordModal
 * Modal for entering password when switching NoorSigner accounts
 */

import { ModalService } from '../../services/ModalService';
import { _ } from '../../i18n';
import { KeySignerClient } from '../../services/KeySignerClient';
import { wireNoorSignerPasswordModal } from './noorSignerPasswordModalShared';

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

  constructor(options: KeySignerPasswordModalOptions) {
    this.modalService = ModalService.getInstance();
    this.keySignerClient = KeySignerClient.getInstance();
    this.options = options;
  }

  public show(): void {
    const content = this.renderContent();

    this.modalService.show({
      title: _('Enter Password'),
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
          ${_('Switching to:')} <strong>${displayName}</strong>
        </p>
        <input
          type="password"
          id="keysigner-password-input"
          class="input"
          placeholder="${_('Enter NoorSigner password...')}"
          autocomplete="off"
        />
        <p class="keysigner-password-modal__error" id="keysigner-password-error" style="display: none;"></p>
        <div class="l-row l-row--end-pair">
          <button type="button" class="btn btn--passive" id="keysigner-password-cancel-btn">
            ${_('Cancel')}
          </button>
          <button type="button" class="btn" id="keysigner-password-submit-btn">
            ${_('Switch Account')}
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

    let switchResult: { pubkey: string; npub: string } | null = null;

    wireNoorSignerPasswordModal({
      input,
      cancelBtn,
      submitBtn,
      errorEl,
      busyLabel: 'Switching...',
      idleLabel: 'Switch Account',
      submit: async () => {
        switchResult = await this.keySignerClient.switchAccount(
          this.options.npub,
          input.value
        );
      },
      // NoorSigner returns various error messages for wrong password
      isPasswordError: message =>
        message.includes('invalid password') ||
        message.includes('corrupted') ||
        message.includes('decrypt'),
      hide: () => this.modalService.hide(),
      onSuccess: () => this.options.onSuccess(switchResult!),
      onCancel: () => this.options.onCancel?.(),
      showError: message => this.showError(message),
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
