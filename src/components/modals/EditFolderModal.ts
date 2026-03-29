/**
 * EditFolderModal
 * Modal to rename an existing folder
 */

import { ModalService } from '../../services/ModalService';
import { escapeHtml } from '../../helpers/escapeHtml';

export interface EditFolderModalOptions {
  currentName: string;
  onSave: (newName: string) => void;
}

export class EditFolderModal {
  private modalService: ModalService;
  private options: EditFolderModalOptions;

  constructor(options: EditFolderModalOptions) {
    this.modalService = ModalService.getInstance();
    this.options = options;
  }

  public show(): void {
    const content = this.renderContent();

    this.modalService.show({
      title: 'Rename Folder',
      content,
      width: '400px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true
    });

    setTimeout(() => {
      this.setupEventHandlers();
      const input = document.getElementById('edit-folder-input') as HTMLInputElement;
      input?.focus();
      input?.select();
    }, 0);
  }

  private renderContent(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'edit-folder-modal';

    container.innerHTML = `
      <div class="edit-folder-modal__content">
        <input
          type="text"
          id="edit-folder-input"
          class="input"
          value="${escapeHtml(this.options.currentName)}"
          placeholder="Enter folder name..."
          maxlength="50"
          autocomplete="off"
        />
        <div class="edit-folder-modal__actions">
          <button type="button" class="btn btn--passive" id="edit-folder-cancel-btn">
            Cancel
          </button>
          <button type="button" class="btn" id="edit-folder-save-btn">
            Save
          </button>
        </div>
      </div>
    `;

    return container;
  }

  private setupEventHandlers(): void {
    const input = document.getElementById('edit-folder-input') as HTMLInputElement;
    const cancelBtn = document.getElementById('edit-folder-cancel-btn');
    const saveBtn = document.getElementById('edit-folder-save-btn');

    if (!input || !cancelBtn || !saveBtn) return;

    const handleSave = () => {
      const name = input.value.trim();
      if (name && name !== this.options.currentName) {
        this.modalService.hide();
        this.options.onSave(name);
      } else if (name === this.options.currentName) {
        this.modalService.hide();
      }
    };

    cancelBtn.addEventListener('click', () => {
      this.modalService.hide();
    });

    saveBtn.addEventListener('click', handleSave);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        handleSave();
      } else if (e.key === 'Escape') {
        this.modalService.hide();
      }
    });
  }

}
