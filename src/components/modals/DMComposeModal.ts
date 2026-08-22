/**
 * DMComposeModal - Modal for composing new direct messages
 * Used to start new DM conversations from MessagesView
 *
 * @component DMComposeModal
 * @purpose Start new DM conversations with user search
 * @used-by MessagesView
 */

import { ModalService } from '../../services/ModalService';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { DMsModuleApi } from '../../modules/dms/contracts';
import { ToastService } from '../../services/ToastService';
import { AuthGuard } from '../../services/AuthGuard';
import { UserSearchInput } from '../user-search/UserSearchInput';

export class DMComposeModal {
  private modalService: ModalService;
  private _dmsApi?: DMsModuleApi | null;
  private get dmsApi(): DMsModuleApi | null {
    return (this._dmsApi ??=
      ModuleLoader.getInstance().getApi<DMsModuleApi>('dms'));
  }
  private userSearchInput: UserSearchInput | null = null;
  private isSending: boolean = false;

  constructor() {
    this.modalService = ModalService.getInstance();
  }

  /**
   * Show the compose modal
   */
  public show(): void {
    if (!AuthGuard.requireAuth('send direct message')) {
      return;
    }

    const content = this.createContent();

    this.modalService.show({
      title: 'New Message',
      content,
      width: '500px',
      height: 'auto',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true,
      onClose: () => this.cleanup(),
    });

    // Focus recipient input after modal renders
    setTimeout(() => {
      this.userSearchInput?.focus();
    }, 50);
  }

  /**
   * Create modal content
   */
  private createContent(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'dm-compose-modal';

    // Create UserSearchInput for recipient
    this.userSearchInput = new UserSearchInput({
      placeholder: 'Search by name or paste npub...',
      onUserSelected: () => {
        // Focus textarea when user is selected
        const textarea = container.querySelector(
          '.dm-compose-modal__textarea'
        ) as HTMLTextAreaElement;
        textarea?.focus();
      },
    });

    container.innerHTML = `
      <div class="dm-compose-modal__content">
        <div class="dm-compose-modal__field">
          <label class="dm-compose-modal__label">To</label>
          <div class="dm-compose-modal__recipient"></div>
        </div>

        <div class="dm-compose-modal__field">
          <label class="dm-compose-modal__label">Message</label>
          <textarea
            class="textarea dm-compose-modal__textarea"
            placeholder="Write your message..."
            rows="4"
          ></textarea>
        </div>

        <div class="dm-compose-modal__actions">
          <button type="button" class="btn btn--passive dm-compose-modal__cancel">Cancel</button>
          <button type="button" class="btn dm-compose-modal__send" disabled>
            <span class="btn__text">Send</span>
            <span class="btn__loading" style="display: none;">Sending...</span>
          </button>
        </div>
      </div>
    `;

    // Insert UserSearchInput
    const recipientContainer = container.querySelector(
      '.dm-compose-modal__recipient'
    );
    if (recipientContainer) {
      recipientContainer.appendChild(this.userSearchInput.getElement());
    }

    // Setup event handlers
    this.setupEventHandlers(container);

    return container;
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(container: HTMLElement): void {
    const textarea = container.querySelector(
      '.dm-compose-modal__textarea'
    ) as HTMLTextAreaElement;
    const cancelBtn = container.querySelector('.dm-compose-modal__cancel');
    const sendBtn = container.querySelector(
      '.dm-compose-modal__send'
    ) as HTMLButtonElement;

    // Cancel button
    cancelBtn?.addEventListener('click', () => {
      this.modalService.hide();
    });

    // Send button
    sendBtn?.addEventListener('click', () => {
      this.handleSend(textarea, sendBtn);
    });

    // Enable/disable send button based on input
    textarea?.addEventListener('input', () => {
      this.updateSendButtonState(textarea, sendBtn);
    });

    // Also update when user is selected/cleared
    if (this.userSearchInput) {
      const originalOnSelected = this.userSearchInput['options'].onUserSelected;
      this.userSearchInput['options'].onUserSelected = (pubkey, profile) => {
        originalOnSelected?.(pubkey, profile);
        this.updateSendButtonState(textarea, sendBtn);
      };

      this.userSearchInput['options'].onSelectionCleared = () => {
        this.updateSendButtonState(textarea, sendBtn);
      };
    }

    // Ctrl/Cmd + Enter to send
    textarea?.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!sendBtn.disabled) {
          this.handleSend(textarea, sendBtn);
        }
      }
    });
  }

  /**
   * Update send button enabled state
   */
  private updateSendButtonState(
    textarea: HTMLTextAreaElement,
    sendBtn: HTMLButtonElement
  ): void {
    const hasRecipient = !!this.userSearchInput?.getSelectedPubkey();
    const hasMessage = textarea.value.trim().length > 0;
    sendBtn.disabled = !hasRecipient || !hasMessage || this.isSending;
  }

  /**
   * Handle send action
   */
  private async handleSend(
    textarea: HTMLTextAreaElement,
    sendBtn: HTMLButtonElement
  ): Promise<void> {
    const recipientPubkey = this.userSearchInput?.getSelectedPubkey();
    const content = textarea.value.trim();

    if (!recipientPubkey || !content) {
      return;
    }

    if (this.isSending) {
      return;
    }

    this.isSending = true;
    this.setLoadingState(sendBtn, true);

    try {
      const success =
        (await this.dmsApi?.sendMessage(recipientPubkey, content)) ?? false;

      if (success) {
        ToastService.show('Message sent', 'success');
        this.modalService.hide();
      } else {
        ToastService.show('Failed to send message', 'error');
        this.isSending = false;
        this.setLoadingState(sendBtn, false);
      }
    } catch (error) {
      ToastService.show('Failed to send message', 'error');
      this.isSending = false;
      this.setLoadingState(sendBtn, false);
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
   * Cleanup on modal close
   */
  private cleanup(): void {
    this.userSearchInput?.destroy();
    this.userSearchInput = null;
    this.isSending = false;
  }
}
