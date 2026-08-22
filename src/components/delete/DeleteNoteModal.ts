/**
 * DeleteNoteModal - Delete Note UI Component
 * Modal for deleting notes (NIP-09)
 * Uses ModalService for modal infrastructure
 */

import { ModalService } from '../../services/ModalService';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { PostsModuleApi } from '../../modules/posts/contracts';
import { ToastService } from '../../services/ToastService';
import { TypedEventBus } from '../../core/TypedEventBus';

export interface DeleteNoteModalOptions {
  /** Event ID to delete */
  eventId: string;
}

export class DeleteNoteModal {
  private static instance: DeleteNoteModal | null = null;
  private modalService: ModalService;
  private _postsApi?: PostsModuleApi | null;
  private get postsApi(): PostsModuleApi | null {
    return (this._postsApi ??=
      ModuleLoader.getInstance().getApi<PostsModuleApi>('posts'));
  }
  private currentOptions: DeleteNoteModalOptions | null = null;

  private constructor() {
    this.modalService = ModalService.getInstance();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): DeleteNoteModal {
    if (!DeleteNoteModal.instance) {
      DeleteNoteModal.instance = new DeleteNoteModal();
    }
    return DeleteNoteModal.instance;
  }

  /**
   * Show delete modal
   */
  public show(options: DeleteNoteModalOptions): void {
    this.currentOptions = options;
    const content = this.renderContent();

    this.modalService.show({
      title: 'Delete Note',
      content,
      width: '500px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true,
    });

    setTimeout(() => {
      this.setupEventHandlers();
    }, 0);
  }

  /**
   * Render modal content
   */
  private renderContent(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'delete-note-modal';

    container.innerHTML = `
      <div class="delete-note-modal__content">
        <p class="delete-note-modal__warning">
          This will send a deletion request to relays.
        </p>
        <p class="delete-note-modal__disclaimer">
          Note: Deletion is not guaranteed - relays may choose to ignore deletion requests.
        </p>
      </div>

      <div class="delete-note-modal__actions">
        <button class="btn btn--passive" data-action="cancel">
          Cancel
        </button>
        <button class="btn btn--danger" data-action="delete">
          Delete Note
        </button>
      </div>
    `;

    return container;
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    const modal = document.querySelector('.delete-note-modal');
    if (!modal) return;

    // Cancel button
    const cancelBtn = modal.querySelector('[data-action="cancel"]');
    cancelBtn?.addEventListener('click', () => {
      this.modalService.hide();
    });

    // Delete button
    const deleteBtn = modal.querySelector('[data-action="delete"]');
    deleteBtn?.addEventListener('click', async () => {
      await this.handleDelete();
    });
  }

  /**
   * Handle deletion
   */
  private async handleDelete(): Promise<void> {
    if (!this.currentOptions) return;

    try {
      const success = await (this.postsApi?.deleteEvent(
        this.currentOptions.eventId
      ) ?? Promise.resolve(false));

      if (success) {
        // Close modal
        this.modalService.hide();

        // Notify UI to remove note from timeline
        const eventBus = TypedEventBus.getInstance();
        eventBus.emit('note:deleted', { eventId: this.currentOptions.eventId });
      } else {
        ToastService.show('Failed to send deletion request', 'error');
      }
    } catch (error) {
      console.error('Failed to delete note:', error);
      ToastService.show('An error occurred while deleting the note', 'error');
    }
  }
}
