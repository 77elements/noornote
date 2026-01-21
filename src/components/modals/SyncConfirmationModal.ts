/**
 * SyncConfirmationModal
 * Confirms sync operations when local list differs from source (relay/file)
 * Shows diff (added/removed/moved items) and asks user whether to keep local or overwrite
 */

import { ModalService } from '../../services/ModalService';
import { setupUserMentionHandlers } from '../../helpers/UserMentionHelper';

/**
 * Moved item with folder assignment change
 */
export interface MovedItemInfo<T> {
  item: T;
  browserFolder: string;  // Current folder name in browser
  sourceFolder: string;   // Folder name in source (relay/file)
}

export interface SyncConfirmationOptions<T> {
  /** Name of the list type (e.g., "Bookmarks", "Follows", "Muted Users") */
  listType: string;
  /** Items that will be added from relay */
  added: T[];
  /** Items that will be removed (exist locally but not on relay) */
  removed: T[];
  /** Items with different folder assignments */
  moved?: MovedItemInfo<T>[];
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

interface ResolvedMovedItem {
  name: string;
  html?: string;
  browserFolder: string;
  sourceFolder: string;
}

export class SyncConfirmationModal<T> {
  private modalService: ModalService;
  private options: SyncConfirmationOptions<T>;
  private resolvedAddedItems: ResolvedItem[] = [];
  private resolvedRemovedItems: ResolvedItem[] = [];
  private resolvedMovedItems: ResolvedMovedItem[] = [];
  private resolvePromise: (() => void) | null = null;

  constructor(options: SyncConfirmationOptions<T>) {
    this.modalService = ModalService.getInstance();
    this.options = options;
  }

  /**
   * Show sync confirmation modal
   * Returns a Promise that resolves when user makes a choice
   */
  public async show(): Promise<void> {
    // Resolve all display names first
    await this.resolveDisplayNames();

    const content = this.renderContent();

    // Create a promise that will be resolved when user clicks a button
    return new Promise<void>((resolve) => {
      this.resolvePromise = resolve;

      this.modalService.show({
        title: `⚠️ Sync ${this.options.listType}`,
        content,
        width: '550px',
        maxHeight: '600px',
        showCloseButton: true,
        closeOnOverlay: false,  // Don't allow closing by overlay click
        closeOnEsc: false       // Don't allow closing by Esc key
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
    });
  }

  /**
   * Resolve display names for all items
   */
  private async resolveDisplayNames(): Promise<void> {
    const { added, removed, moved, getDisplayName, renderItemHtml } = this.options;

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

    // Resolve moved items
    if (moved && moved.length > 0) {
      this.resolvedMovedItems = await Promise.all(
        moved.map(async movedItem => {
          const name = await Promise.resolve(getDisplayName(movedItem.item));
          const result: ResolvedMovedItem = {
            name,
            browserFolder: movedItem.browserFolder,
            sourceFolder: movedItem.sourceFolder
          };
          if (renderItemHtml) {
            result.html = await Promise.resolve(renderItemHtml(movedItem.item));
          }
          return result;
        })
      );
    }
  }

  /**
   * Render modal content
   */
  private renderContent(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'sync-confirmation-modal';

    const { added, removed, moved, listType } = this.options;
    const movedCount = moved?.length || 0;

    // Determine if this is a file sync or relay sync based on listType
    const isFileSync = listType.toLowerCase().includes('file');
    const sourceLabel = isFileSync ? 'file' : 'relay';
    const cleanListType = listType.replace(/\s*\(File\)\s*/i, '').toLowerCase();

    // Build the question text based on what differs
    const hasRemoved = removed.length > 0;
    const hasMoved = movedCount > 0;

    let questionText = '';
    if (hasRemoved && hasMoved) {
      questionText = `What should happen with these differences?`;
    } else if (hasRemoved) {
      questionText = `What should happen with the ${removed.length} item${removed.length > 1 ? 's' : ''} only in NoorNote Memory?`;
    } else if (hasMoved) {
      questionText = `What should happen with the ${movedCount} item${movedCount > 1 ? 's' : ''} in different folders?`;
    }

    container.innerHTML = `
      <div class="sync-confirmation-modal__content">
        <div class="sync-confirmation-modal__warning">
          <p class="sync-confirmation-modal__message">
            Your ${cleanListType} in NoorNote Memory differs from the ${sourceLabel} version.
          </p>
        </div>

        ${removed.length > 0 ? `
          <div class="sync-confirmation-modal__section">
            <h3 class="sync-confirmation-modal__section-title">
              ❌ Only in NoorNote Memory (${removed.length} item${removed.length > 1 ? 's' : ''})
            </h3>
            <div class="sync-confirmation-modal__list">
              ${this.renderItems(this.resolvedRemovedItems)}
            </div>
          </div>
        ` : ''}

        ${movedCount > 0 ? `
          <div class="sync-confirmation-modal__section">
            <h3 class="sync-confirmation-modal__section-title">
              📁 Different folder (${movedCount} item${movedCount > 1 ? 's' : ''})
            </h3>
            <div class="sync-confirmation-modal__list">
              ${this.renderMovedItems(this.resolvedMovedItems, sourceLabel)}
            </div>
          </div>
        ` : ''}

        ${added.length > 0 ? `
          <div class="sync-confirmation-modal__section">
            <h3 class="sync-confirmation-modal__section-title">
              ✅ New from ${sourceLabel} (${added.length} item${added.length > 1 ? 's' : ''})
            </h3>
            <div class="sync-confirmation-modal__list">
              ${this.renderItems(this.resolvedAddedItems)}
            </div>
          </div>
        ` : ''}

        <div class="sync-confirmation-modal__question">
          <p><strong>${questionText}</strong></p>
        </div>

        <div class="sync-confirmation-modal__actions">
          <button type="button" class="btn btn--passive" id="sync-keep-btn">
            Keep actual state
          </button>
          <button type="button" class="btn btn--danger" id="sync-delete-btn">
            Overwrite with ${sourceLabel} backup
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
   * Render moved items with folder info
   */
  private renderMovedItems(items: ResolvedMovedItem[], sourceLabel: string): string {
    const maxShow = 10;
    const itemsToShow = items.slice(0, maxShow);
    const remaining = items.length - maxShow;

    let html = itemsToShow
      .map(item => {
        const content = item.html || this.escapeHtml(item.name);
        const browserFolderDisplay = item.browserFolder || '(root)';
        const sourceFolderDisplay = item.sourceFolder || '(root)';
        return `
          <div class="sync-confirmation-modal__item sync-confirmation-modal__item--moved">
            <span class="sync-confirmation-modal__item-name">${content}</span>
            <span class="sync-confirmation-modal__item-folders">
              <span class="sync-confirmation-modal__folder sync-confirmation-modal__folder--local">${this.escapeHtml(browserFolderDisplay)}</span>
              <span class="sync-confirmation-modal__folder-arrow">→</span>
              <span class="sync-confirmation-modal__folder sync-confirmation-modal__folder--source">${this.escapeHtml(sourceFolderDisplay)}</span>
              <span class="sync-confirmation-modal__folder-label">(${sourceLabel})</span>
            </span>
          </div>
        `;
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
      // Resolve anyway to prevent hanging
      if (this.resolvePromise) {
        this.resolvePromise();
        this.resolvePromise = null;
      }
      return;
    }

    // Keep button (merge strategy)
    keepBtn.addEventListener('click', () => {
      this.modalService.hide();
      this.options.onKeep();
      if (this.resolvePromise) {
        this.resolvePromise();
        this.resolvePromise = null;
      }
    });

    // Delete button (overwrite strategy)
    deleteBtn.addEventListener('click', () => {
      this.modalService.hide();
      this.options.onDelete();
      if (this.resolvePromise) {
        this.resolvePromise();
        this.resolvePromise = null;
      }
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
