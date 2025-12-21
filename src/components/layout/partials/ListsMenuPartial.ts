/**
 * ListsMenuPartial
 * Sidebar accordion menu for accessing list views
 *
 * @purpose Provides expandable "Lists" menu with links to Bookmarks, Follows, Muted Users, Tribes
 * @used-by MainLayout (inserted into .primary-nav)
 */

import type { ListType } from './ListViewPartial';

export interface ListsMenuConfig {
  onListClick: (listType: ListType) => void; // Callback when a list link is clicked
}

export class ListsMenuPartial {
  private config: ListsMenuConfig;
  private element: HTMLElement | null = null;
  private isExpanded: boolean = false;

  constructor(config: ListsMenuConfig) {
    this.config = config;
  }

  /**
   * Create menu element
   */
  public createElement(): HTMLElement {
    const li = document.createElement('li');
    li.className = 'primary-nav__item primary-nav__item--accordion';

    li.innerHTML = `
      <button class="primary-nav__accordion-trigger">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 12h18M3 6h18M3 18h18"></path>
        </svg>
        Lists
      </button>
      <ul class="primary-nav__submenu">
        <li>
          <a href="#" class="primary-nav__sublink" data-list-type="bookmarks">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
            </svg>
            Bookmarks
          </a>
        </li>
        <li>
          <a href="#" class="primary-nav__sublink" data-list-type="follows">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
              <circle cx="9" cy="7" r="4"></circle>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"></path>
            </svg>
            Follows
          </a>
        </li>
        <li>
          <a href="#" class="primary-nav__sublink" data-list-type="mutes">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="1" y1="1" x2="23" y2="23"></line>
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
              <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
              <line x1="12" y1="19" x2="12" y2="23"></line>
              <line x1="8" y1="23" x2="16" y2="23"></line>
            </svg>
            Muted
          </a>
        </li>
        <li>
          <a href="#" class="primary-nav__sublink" data-list-type="tribes">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
              <circle cx="9" cy="7" r="4"></circle>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
            </svg>
            Tribes
          </a>
        </li>
      </ul>
    `;

    // Accordion trigger handler
    const trigger = li.querySelector('.primary-nav__accordion-trigger');
    trigger?.addEventListener('click', (e) => {
      e.preventDefault();
      this.toggle();
    });

    // Sublink handlers
    const sublinks = li.querySelectorAll('.primary-nav__sublink');
    sublinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const listType = (link as HTMLElement).dataset.listType as ListType;
        if (listType) {
          this.config.onListClick(listType);
        }
      });
    });

    this.element = li;
    return li;
  }

  /**
   * Toggle accordion open/close
   */
  public toggle(): void {
    if (!this.element) return;

    this.isExpanded = !this.isExpanded;

    if (this.isExpanded) {
      this.element.classList.add('primary-nav__item--expanded');
    } else {
      this.element.classList.remove('primary-nav__item--expanded');
    }
  }

  /**
   * Expand accordion
   */
  public expand(): void {
    if (!this.element || this.isExpanded) return;
    this.toggle();
  }

  /**
   * Collapse accordion
   */
  public collapse(): void {
    if (!this.element || !this.isExpanded) return;
    this.toggle();
  }

  /**
   * Get element
   */
  public getElement(): HTMLElement | null {
    return this.element;
  }

  /**
   * Destroy (remove from DOM)
   */
  public destroy(): void {
    this.element?.remove();
    this.element = null;
  }
}
