/**
 * FolderCard
 * Renders a folder (bookmark category/set) as a draggable card
 *
 * @purpose Display folder with name, item count, and drop target for bookmarks
 * @used-by BookmarkSecondaryManager
 */

import { ICON_TRASH_14 } from '../../helpers/svgIcons';

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
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M3 7V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V9C21 7.89543 20.1046 7 19 7H12L10 5H5C3.89543 5 3 5.89543 3 7Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="folder-card__name">${this.escapeHtml(name)}</div>
      <div class="folder-card__count">${itemCount} ${itemCount === 1 ? 'item' : 'items'}</div>
      <div class="folder-card__actions">
        <button class="folder-card__edit" aria-label="Rename folder" title="Rename folder">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M11.5 2.5l2 2M2 14l1-4 9-9 2 2-9 9-4 1z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
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

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
