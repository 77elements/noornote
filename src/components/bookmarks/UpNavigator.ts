/**
 * UpNavigator
 * The ".." element that appears as the first item in a folder view
 * Allows navigation back to root and serves as drop target
 *
 * @purpose Navigate up from folder to root, accept dropped items
 * @used-by BookmarkSecondaryManager
 */

export interface UpNavigatorOptions {
  onClick: () => void;
  onDrop: (bookmarkId: string) => Promise<void>;
}

export class UpNavigator {
  private options: UpNavigatorOptions;
  private element: HTMLElement | null = null;

  constructor(options: UpNavigatorOptions) {
    this.options = options;
  }

  public render(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'nn-card';
    card.dataset.upNav = '';
    card.title = 'Up to root level';

    card.innerHTML = `
      <div class="nn-card__content">
        <div class="icon">
          <svg width="24" height="24"><use href="#icon-corner-up-left"/></svg>
        </div>
        <div class="label">..</div>
        <div class="hint">Back to root</div>
      </div>
    `;

    this.bindEvents(card);
    this.element = card;
    return card;
  }

  private bindEvents(card: HTMLElement): void {
    // Click navigates up
    card.addEventListener('click', () => {
      this.options.onClick();
    });

    // Drag & Drop - as drop target
    card.addEventListener('dragover', e => {
      e.preventDefault();
      if (e.dataTransfer?.types.includes('application/x-bookmark-id')) {
        card.classList.add('drag-over');
      }
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', async e => {
      e.preventDefault();
      card.classList.remove('drag-over');

      const bookmarkId = e.dataTransfer?.getData('application/x-bookmark-id');
      if (bookmarkId) {
        await this.options.onDrop(bookmarkId);
      }
    });
  }

  public getElement(): HTMLElement | null {
    return this.element;
  }
}
