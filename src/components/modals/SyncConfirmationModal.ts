/**
 * SyncConfirmationModal
 * Confirms sync operations when local list has MORE items than relay list
 * Shows diff (added/removed items) and asks user whether to keep or delete local-only items
 */

import { ModalService } from '../../services/ModalService';
import { setupUserMentionHandlers } from '../../helpers/UserMentionHelper';

export interface SyncConfirmationOptions<T> {
  /** Name of the list type (e.g., "Bookmarks", "Follows", "Muted Users") */
  listType: string;
  /** Items that will be added from relay */
  added: T[];
  /** Items that will be removed (exist locally but not on relay) */
  removed: T[];
  /** Function to get displayable name for an item (text only) */
  getDisplayName: (item: T) => string | Promise<string>;
  /** Optional: Function to render item as HTML (for mentions with avatar) */
  renderItemHtml?: (item: T) => string | Promise<string>;
  /** Callback when user chooses "Keep local items" (merge strategy) */
  onKeep: () => void;
  /** Callback when user chooses "Delete here too" (overwrite strategy) */
  onDelete: () => void;
}

interface ResolvedItem {
  name: string;
  html?: string;
}

export class SyncConfirmationModal<T> {
  private modalService: ModalService;
  private options: SyncConfirmationOptions<T>;
  private resolvedAddedItems: ResolvedItem[] = [];
  private resolvedRemovedItems: ResolvedItem[] = [];

  constructor(options: SyncConfirmationOptions<T>) {
    this.modalService = ModalService.getInstance();
    this.options = options;
  }

  /**
   * Show sync confirmation modal
   */
  public async show(): Promise<void> {
    // Resolve all display names first
    await this.resolveDisplayNames();

    const content = this.renderContent();

    this.modalService.show({
      title: `⚠️ Sync ${this.options.listType}`,
      content,
      width: '550px',
      maxHeight: '600px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true
    });

    // Setup event handlers
    setTimeout(() => {
      this.setupEventHandlers();
      // Setup mention handlers if HTML rendering is used
      if (this.options.renderItemHtml) {
        const modalContent = document.querySelector('.sync-confirmation-modal');
        if (modalContent) {
          setupUserMentionHandlers(modalContent as HTMLElement);
        }
      }
    }, 0);
  }

  /**
   * Resolve display names for all items
   */
  private async resolveDisplayNames(): Promise<void> {
    const { added, removed, getDisplayName, renderItemHtml } = this.options;

    // Resolve added items
    this.resolvedAddedItems = await Promise.all(
      added.map(async item => {
        const name = await Promise.resolve(getDisplayName(item));
        const result: ResolvedItem = { name };
        if (renderItemHtml) {
          result.html = await Promise.resolve(renderItemHtml(item));
        }
        return result;
      })
    );

    // Resolve removed items
    this.resolvedRemovedItems = await Promise.all(
      removed.map(async item => {
        const name = await Promise.resolve(getDisplayName(item));
        const result: ResolvedItem = { name };
        if (renderItemHtml) {
          result.html = await Promise.resolve(renderItemHtml(item));
        }
        return result;
      })
    );
  }

  /**
   * Render modal content
   */
  private renderContent(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'sync-confirmation-modal';

    const { added, removed, listType } = this.options;

    container.innerHTML = `
      <div class="sync-confirmation-modal__content">
        <div class="sync-confirmation-modal__warning">
          <p class="sync-confirmation-modal__message">
            Your local ${listType.toLowerCase()} list differs from the relay version.
          </p>
        </div>

        ${removed.length > 0 ? `
          <div class="sync-confirmation-modal__section">
            <h3 class="sync-confirmation-modal__section-title">
              ❌ Removed on relay (${removed.length} item${removed.length > 1 ? 's' : ''})
            </h3>
            <div class="sync-confirmation-modal__list">
              ${this.renderItems(this.resolvedRemovedItems)}
            </div>
          </div>
        ` : ''}

        ${added.length > 0 ? `
          <div class="sync-confirmation-modal__section">
            <h3 class="sync-confirmation-modal__section-title">
              ✅ New on relay (${added.length} item${added.length > 1 ? 's' : ''})
            </h3>
            <div class="sync-confirmation-modal__list">
              ${this.renderItems(this.resolvedAddedItems)}
            </div>
          </div>
        ` : ''}

        <div class="sync-confirmation-modal__question">
          <p><strong>What should happen with the ${removed.length} item${removed.length > 1 ? 's' : ''} removed on relay?</strong></p>
        </div>

        <div class="sync-confirmation-modal__actions">
          <button type="button" class="btn btn--passive" id="sync-keep-btn">
            Keep and only add
            <span class="btn__hint">(Merge: Keep ${removed.length} + Add ${added.length})</span>
          </button>
          <button type="button" class="btn btn--danger" id="sync-delete-btn">
            Delete and add
            <span class="btn__hint">(Overwrite: Delete ${removed.length} + Add ${added.length})</span>
          </button>
        </div>
      </div>
    `;

    return container;
  }

  /**
   * Render items (limited to 10, show "+X more" if needed)
   */
  private renderItems(items: ResolvedItem[]): string {
    const maxShow = 10;
    const itemsToShow = items.slice(0, maxShow);
    const remaining = items.length - maxShow;

    let html = itemsToShow
      .map(item => {
        // Use HTML if available, otherwise escape text
        const content = item.html || this.escapeHtml(item.name);
        return `<div class="sync-confirmation-modal__item">${content}</div>`;
      })
      .join('');

    if (remaining > 0) {
      html += `<div class="sync-confirmation-modal__item sync-confirmation-modal__item--more">+ ${remaining} more...</div>`;
    }

    return html;
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    const keepBtn = document.getElementById('sync-keep-btn');
    const deleteBtn = document.getElementById('sync-delete-btn');

    if (!keepBtn || !deleteBtn) {
      console.error('[SyncConfirmationModal] Failed to find modal buttons');
      return;
    }

    // Keep button (merge strategy)
    keepBtn.addEventListener('click', () => {
      this.modalService.hide();
      this.options.onKeep();
    });

    // Delete button (overwrite strategy)
    deleteBtn.addEventListener('click', () => {
      this.modalService.hide();
      this.options.onDelete();
    });
  }

  /**
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
