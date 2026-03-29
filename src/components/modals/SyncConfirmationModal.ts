/**
 * SyncConfirmationModal
 * Confirms sync operations when local list differs from source (relay/file)
 * Shows diff (added/removed/moved items) and asks user whether to only add new ones or accept changes
 */

import { ModalService } from '../../services/ModalService';
import { setupUserMentionHandlers } from '../../helpers/UserMentionHelper';
import { diagLog } from '../../services/DiagnosticLogger';
import { escapeHtml } from '../../helpers/escapeHtml';

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
  /** Human-readable descriptions of snapshot differences (order, properties, etc.) */
  snapshotDetails?: string[];
  /** Function to get displayable name for an item (text only) */
  getDisplayName: (item: T) => string | Promise<string>;
  /** Optional: Function to render item as HTML (for mentions with avatar) */
  renderItemHtml?: (item: T) => string | Promise<string>;
  /** Callback: "Keep all" — merge local + relay, push result */
  onKeep: () => void | Promise<void>;
  /** Callback: "Keep relay" — replace local with relay */
  onRelay: () => void | Promise<void>;
  /** Callback: "Keep local" — push local to relay, discard relay-only items */
  onLocal: () => void | Promise<void>;
  /** Callback: "Merge both" — for bookmarks/tribes with folder structure merge */
  onMerge?: () => void | Promise<void>;
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
    diagLog('lists', 'SyncConfirmationModal show', {
      listType: this.options.listType,
      addedCount: this.options.added.length,
      removedCount: this.options.removed.length,
      movedCount: this.options.moved?.length || 0,
      hasOnMerge: !!this.options.onMerge
    });
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
        height: '600px',
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

    const isFileSync = listType.toLowerCase().includes('file');
    const sourceLabel = isFileSync ? 'file' : 'relay';

    const snapshotDetails = this.options.snapshotDetails || [];
    const hasSnapshotDetails = snapshotDetails.length > 0;

    const sourceUp = sourceLabel.charAt(0).toUpperCase() + sourceLabel.slice(1);

    container.innerHTML = `
      <div class="sync-confirmation-modal__content">
        ${removed.length > 0 ? `
          <div class="sync-confirmation-modal__section">
            <h2 class="sync-confirmation-modal__section-title">
              Locally: + ${removed.length} item${removed.length > 1 ? 's' : ''}, not in the ${sourceLabel}s
            </h3>
            <div class="sync-confirmation-modal__list">
              ${this.renderItems(this.resolvedRemovedItems)}
            </div>
          </div>
        ` : ''}

        ${movedCount > 0 ? `
          <div class="sync-confirmation-modal__section">
            <h2 class="sync-confirmation-modal__section-title">
              ${movedCount} item${movedCount > 1 ? 's' : ''} in different folders
            </h3>
            <div class="sync-confirmation-modal__list">
              ${this.renderMovedItems(this.resolvedMovedItems, sourceLabel)}
            </div>
          </div>
        ` : ''}

        ${added.length > 0 ? `
          <div class="sync-confirmation-modal__section">
            <h2 class="sync-confirmation-modal__section-title">
              ${sourceUp}s: ${added.length} item${added.length > 1 ? 's' : ''}, not stored locally
            </h3>
            <div class="sync-confirmation-modal__list">
              ${this.renderItems(this.resolvedAddedItems)}
            </div>
          </div>
        ` : ''}

        ${hasSnapshotDetails ? `
          <div class="sync-confirmation-modal__section">
            <h2 class="sync-confirmation-modal__section-title">
              Other differences
            </h3>
            <div class="sync-confirmation-modal__list">
              ${snapshotDetails.map(d => `<div class="sync-confirmation-modal__item">${escapeHtml(d)}</div>`).join('')}
            </div>
          </div>
        ` : ''}

        <div class="sync-confirmation-modal__actions">
          <button type="button" class="btn btn--success" id="sync-keep-btn">
            Keep all
          </button>
          <button type="button" class="btn btn--primary" id="sync-relay-btn">
            Keep relay
          </button>
          <button type="button" class="btn btn--passive" id="sync-local-btn">
            Keep local
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
        const content = item.html || escapeHtml(item.name);
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
        const content = item.html || escapeHtml(item.name);
        const browserFolderDisplay = item.browserFolder || '(root)';
        const sourceFolderDisplay = item.sourceFolder || '(root)';
        return `
          <div class="sync-confirmation-modal__item sync-confirmation-modal__item--moved">
            <span class="sync-confirmation-modal__item-name">${content}</span>
            <span class="sync-confirmation-modal__item-folders">
              <span class="sync-confirmation-modal__folder sync-confirmation-modal__folder--local">${escapeHtml(browserFolderDisplay)}</span>
              <span class="sync-confirmation-modal__folder-arrow">→</span>
              <span class="sync-confirmation-modal__folder sync-confirmation-modal__folder--source">${escapeHtml(sourceFolderDisplay)}</span>
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
   * Setup event handlers — all callbacks are awaited before resolving the modal promise
   */
  private setupEventHandlers(): void {
    const keepBtn = document.getElementById('sync-keep-btn');
    const relayBtn = document.getElementById('sync-relay-btn');
    const localBtn = document.getElementById('sync-local-btn');

    if (!keepBtn || !relayBtn || !localBtn) {
      console.error('[SyncConfirmationModal] Failed to find modal buttons');
      if (this.resolvePromise) {
        this.resolvePromise();
        this.resolvePromise = null;
      }
      return;
    }

    const handle = (name: string, callback: () => void | Promise<void>) => {
      return async () => {
        this.modalService.hide();
        diagLog('lists', `SyncConfirmationModal ${name} clicked`, { listType: this.options.listType });
        try {
          await callback();
        } catch (error) {
          console.error(`[SyncModal] ${name}: callback FAILED:`, error);
        }
        if (this.resolvePromise) {
          this.resolvePromise();
          this.resolvePromise = null;
        }
      };
    };

    keepBtn.addEventListener('click', handle('Keep all', this.options.onKeep));
    relayBtn.addEventListener('click', handle('Keep relay', this.options.onRelay));
    localBtn.addEventListener('click', handle('Keep local', this.options.onLocal));
  }

}
