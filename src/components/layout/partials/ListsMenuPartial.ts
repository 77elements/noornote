/**
 * ListsMenuPartial
 * Sidebar accordion menu for accessing list views
 *
 * @purpose Provides expandable "Lists" menu with links to Bookmarks, Follows, Muted Users, Tribes
 * @used-by MainLayout (inserted into .primary-nav)
 */

import type { ListType } from './ListViewPartial';
import { isBookmarksEnabled } from '../../../addons/bookmarks/index';
import { isTribesEnabled } from '../../../addons/tribes/index';

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
        <svg width="24" height="24"><use href="#icon-hamburger"/></svg>
        Lists
      </button>
      <ul class="primary-nav__submenu">
        <li class="bookmarks-item" style="${isBookmarksEnabled() ? '' : 'display: none;'}">
          <a href="#" class="primary-nav__sublink" data-list-type="bookmarks">
            <svg class="primary-nav__sublink-icon"><use href="#icon-bookmark-24"/></svg>
            <span class="primary-nav__sublink-desc">Bookmarks</span>
          </a>
        </li>
        <li>
          <a href="#" class="primary-nav__sublink" data-list-type="follows">
            <svg class="primary-nav__sublink-icon"><use href="#icon-follows"/></svg>
            <span class="primary-nav__sublink-desc">Follows</span>
          </a>
        </li>
        <li>
          <a href="#" class="primary-nav__sublink" data-list-type="mutes">
            <svg class="primary-nav__sublink-icon"><use href="#icon-mute-mic"/></svg>
            <span class="primary-nav__sublink-desc">Muted</span>
          </a>
        </li>
        <li class="tribes-item" style="${isTribesEnabled() ? '' : 'display: none;'}">
          <a href="#" class="primary-nav__sublink" data-list-type="tribes">
            <svg class="primary-nav__sublink-icon"><use href="#icon-tribes-circles"/></svg>
            <span class="primary-nav__sublink-desc">Tribes</span>
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
