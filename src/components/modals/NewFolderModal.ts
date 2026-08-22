/**
 * NewFolderModal
 * Simple modal with text input to create a new bookmark folder
 */

import { ModalService } from '../../services/ModalService';

export interface NewFolderModalOptions {
  onConfirm: (folderName: string) => void;
}

export class NewFolderModal {
  private modalService: ModalService;
  private options: NewFolderModalOptions;

  constructor(options: NewFolderModalOptions) {
    this.modalService = ModalService.getInstance();
    this.options = options;
  }

  public show(): void {
    const content = this.renderContent();

    this.modalService.show({
      title: 'New Folder',
      content,
      width: '400px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true,
    });

    setTimeout(() => {
      this.setupEventHandlers();
      // Focus input
      const input = document.getElementById(
        'new-folder-input'
      ) as HTMLInputElement;
      input?.focus();
    }, 0);
  }

  private renderContent(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'new-folder-modal';

    container.innerHTML = `
      <div class="new-folder-modal__content">
        <input
          type="text"
          id="new-folder-input"
          class="input new-folder-input"
          placeholder="Enter folder name..."
          maxlength="50"
          autocomplete="off"
        />
        <div class="new-folder-modal__actions">
          <button type="button" class="btn btn--passive" id="new-folder-cancel-btn">
            Cancel
          </button>
          <button type="button" class="btn" id="new-folder-confirm-btn">
            Create
          </button>
        </div>
      </div>
    `;

    return container;
  }

  private setupEventHandlers(): void {
    const input = document.getElementById(
      'new-folder-input'
    ) as HTMLInputElement;
    const cancelBtn = document.getElementById('new-folder-cancel-btn');
    const confirmBtn = document.getElementById('new-folder-confirm-btn');

    if (!input || !cancelBtn || !confirmBtn) return;

    const handleConfirm = () => {
      const name = input.value.trim();
      if (name) {
        this.modalService.hide();
        this.options.onConfirm(name);
      }
    };

    // Cancel
    cancelBtn.addEventListener('click', () => {
      this.modalService.hide();
    });

    // Confirm
    confirmBtn.addEventListener('click', handleConfirm);

    // Enter key
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        handleConfirm();
      } else if (e.key === 'Escape') {
        this.modalService.hide();
      }
    });
  }
}
