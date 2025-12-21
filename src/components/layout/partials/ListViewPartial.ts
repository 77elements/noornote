/**
 * ListViewPartial
 * Generic list view component for secondary-content tabs
 *
 * @purpose Provides unified tab + content structure for all list types
 * @used-by MainLayout (for Bookmarks, Follows, Muted Users, Tribes)
 *
 * Architecture:
 * - ListViewPartial provides the container structure (tab + content area)
 * - Individual managers (BookmarkSecondaryManager, FollowListSecondaryManager, MuteListSecondaryManager, TribeSecondaryManager)
 *   render their specific content into the provided container
 */

export type ListType = 'bookmarks' | 'follows' | 'mutes' | 'tribes';

export interface ListViewConfig {
  type: ListType;
  title: string; // e.g., "List: Bookmarks"
  onClose: () => void; // Callback when [x] button is clicked
  onRender: (container: HTMLElement) => void; // Callback to render list content
}

export class ListViewPartial {
  private config: ListViewConfig;
  private tabElement: HTMLElement | null = null;
  private contentElement: HTMLElement | null = null;

  constructor(config: ListViewConfig) {
    this.config = config;
  }

  /**
   * Create tab button with close [x] button
   */
  public createTab(): HTMLElement {
    const tab = document.createElement('button');
    tab.className = 'tab tab--closable';
    tab.dataset.tab = `list-${this.config.type}`;

    tab.innerHTML = `
      <span class="tab__label">${this.config.title}</span>
      <button class="tab__close" aria-label="Close list" title="Close list">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="7" cy="7" r="6.5" stroke="currentColor" stroke-width="1"/>
          <path d="M4.5 4.5l5 5M9.5 4.5l-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    `;

    // Close button handler
    const closeBtn = tab.querySelector('.tab__close');
    closeBtn?.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent tab activation
      this.config.onClose();
    });

    this.tabElement = tab;
    return tab;
  }

  /**
   * Create tab content container
   */
  public createContent(): HTMLElement {
    const content = document.createElement('div');
    content.className = 'tab-content';
    content.dataset.tabContent = `list-${this.config.type}`;

    this.contentElement = content;
    return content;
  }

  /**
   * Render list content (delegates to manager)
   */
  public renderContent(): void {
    if (this.contentElement) {
      this.config.onRender(this.contentElement);
    }
  }

  /**
   * Activate this tab
   */
  public activate(): void {
    if (this.tabElement) {
      this.tabElement.classList.add('tab--active');
    }
    if (this.contentElement) {
      this.contentElement.classList.add('tab-content--active');
    }
  }

  /**
   * Deactivate this tab
   */
  public deactivate(): void {
    if (this.tabElement) {
      this.tabElement.classList.remove('tab--active');
    }
    if (this.contentElement) {
      this.contentElement.classList.remove('tab-content--active');
    }
  }

  /**
   * Remove tab and content from DOM
   */
  public destroy(): void {
    this.tabElement?.remove();
    this.contentElement?.remove();
    this.tabElement = null;
    this.contentElement = null;
  }

  /**
   * Get tab element
   */
  public getTab(): HTMLElement | null {
    return this.tabElement;
  }

  /**
   * Get content element
   */
  public getContent(): HTMLElement | null {
    return this.contentElement;
  }

  /**
   * Get list type
   */
  public getType(): ListType {
    return this.config.type;
  }
}
