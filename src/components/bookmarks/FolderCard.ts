/**
 * FolderCard
 * Renders a folder (bookmark category/set) as a draggable card
 *
 * @purpose Display folder with name, item count, and drop target for bookmarks
 * @used-by BookmarkSecondaryManager
 */

import { ICON_TRASH_14 } from '../../helpers/svgIcons';
import { escapeHtml } from '../../helpers/escapeHtml';

export interface FolderData {
  id: string;           // d-tag identifier
  name: string;         // title tag or d-tag
  itemCount: number;    // Number of bookmarks in folder
  isMounted?: boolean;  // Is this folder mounted to profile?
}

export interface FolderCardOptions {
  onClick: (folderId: string) => void;
  onEdit?: (folderId: string) => void;
  onDelete: (folderId: string) => Promise<void>;
  onDrop: (bookmarkId: string, folderId: string) => Promise<void>;
  onDragStart?: (folderId: string, element: HTMLElement) => void;
  onDragEnd?: () => void;
  onMountToggle?: (folderId: string, folderName: string) => void;
  showMountCheckbox?: boolean;  // Only show for logged-in user's own bookmarks
}

export class FolderCard {
  private data: FolderData;
  private options: FolderCardOptions;
  private element: HTMLElement | null = null;

  constructor(data: FolderData, options: FolderCardOptions) {
    this.data = data;
    this.options = options;
  }

  public render(): HTMLElement {
    const { id, name, itemCount, isMounted } = this.data;
    const showMount = this.options.showMountCheckbox && this.options.onMountToggle;

    const card = document.createElement('div');
    card.className = 'folder-card';
    card.dataset.folderId = id;
    card.draggable = true;

    card.innerHTML = `
      <div class="folder-card__icon">
        <svg width="24" height="24"><use href="#icon-folder-24"/></svg>
      </div>
      <div class="folder-card__name">${escapeHtml(name)}</div>
      <div class="folder-card__count">${itemCount} ${itemCount === 1 ? 'item' : 'items'}</div>
      <div class="folder-card__actions">
        <button class="folder-card__edit" aria-label="Rename folder" title="Rename folder">
          <svg width="14" height="14"><use href="#icon-pencil-16"/></svg>
        </button>
        <button class="folder-card__delete" aria-label="Delete folder" title="Delete folder (items move to root)">
          ${ICON_TRASH_14}
        </button>
      </div>
      ${showMount ? `
        <label class="folder-card__mount" title="Mount to Profile">
          <span>Profile</span>
          <input type="checkbox" ${isMounted ? 'checked' : ''} />
        </label>
      ` : ''}
    `;

    this.bindEvents(card);
    this.element = card;
    return card;
  }

  private bindEvents(card: HTMLElement): void {
    const { id, name } = this.data;

    // Click on folder (except actions and mount checkbox) opens it
    card.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.folder-card__actions')) return;
      if (target.closest('.folder-card__mount')) return;
      this.options.onClick(id);
    });

    // Edit button
    const editBtn = card.querySelector('.folder-card__edit');
    editBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.options.onEdit?.(id);
    });

    // Delete button
    const deleteBtn = card.querySelector('.folder-card__delete');
    deleteBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.options.onDelete(id);
      card.remove();
    });

    // Mount checkbox
    const mountCheckbox = card.querySelector('.folder-card__mount input') as HTMLInputElement;
    if (mountCheckbox && this.options.onMountToggle) {
      mountCheckbox.addEventListener('change', (e) => {
        e.stopPropagation();
        this.options.onMountToggle!(id, name);
      });
      // Prevent label click from triggering card click
      const mountLabel = card.querySelector('.folder-card__mount');
      mountLabel?.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }

    // Drag & Drop - as draggable
    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', id);
      e.dataTransfer?.setData('application/x-folder-id', id);
      this.options.onDragStart?.(id, card);
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      this.options.onDragEnd?.();
    });

    // Drag & Drop - as drop target
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      // Only accept bookmark drops, not folder drops
      if (e.dataTransfer?.types.includes('application/x-bookmark-id')) {
        card.classList.add('drag-over');
      }
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');

      const bookmarkId = e.dataTransfer?.getData('application/x-bookmark-id');
      if (bookmarkId) {
        await this.options.onDrop(bookmarkId, id);
      }
    });
  }


  public getElement(): HTMLElement | null {
    return this.element;
  }

  public getFolderId(): string {
    return this.data.id;
  }

  public updateCount(count: number): void {
    this.data.itemCount = count;
    const countEl = this.element?.querySelector('.folder-card__count');
    if (countEl) {
      countEl.textContent = `${count} ${count === 1 ? 'item' : 'items'}`;
    }
  }

  public updateMountStatus(isMounted: boolean): void {
    this.data.isMounted = isMounted;
    const checkbox = this.element?.querySelector('.folder-card__mount input') as HTMLInputElement;
    if (checkbox) {
      checkbox.checked = isMounted;
    }
  }
}
