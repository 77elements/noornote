/**
 * ListsMenuPartial
 * Sidebar accordion menu for accessing list views
 *
 * @purpose Provides expandable "Lists" menu with links to Bookmarks, Follows, Muted Users, Tribes
 * @used-by MainLayout (inserted into .primary-nav)
 */

import type { ListType } from './ListViewPartial';
import { ToastService } from '../../../services/ToastService';
import { PlatformService } from '../../../services/PlatformService';
import { isBookmarksEnabled } from '../../../addons/bookmarks/index';
import { isTribesEnabled } from '../../../addons/tribes/index';

export interface ListsMenuConfig {
  onListClick: (listType: ListType) => void; // Callback when a list link is clicked
}

// Easter egg: typing "nip51" anywhere reveals the NIP-51 Inspector
const EASTER_EGG_CODE = 'nip51';
const STORAGE_KEY = 'noornote_nip51_unlocked';

export class ListsMenuPartial {
  private config: ListsMenuConfig;
  private element: HTMLElement | null = null;
  private isExpanded: boolean = false;
  private easterEggBuffer: string = '';
  private easterEggUnlocked: boolean = false;
  private keyListener: ((e: KeyboardEvent) => void) | null = null;

  constructor(config: ListsMenuConfig) {
    this.config = config;
    // No easter egg on mobile (no keyboard to type the code)
    this.easterEggUnlocked = !PlatformService.getInstance().isAndroid && sessionStorage.getItem(STORAGE_KEY) === 'true';
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
        <li class="bookmarks-item" style="${isBookmarksEnabled() ? '' : 'display: none;'}">
          <a href="#" class="primary-nav__sublink" data-list-type="bookmarks">
            <svg class="primary-nav__sublink-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
            </svg>
            <span class="primary-nav__sublink-desc">Bookmarks</span>
          </a>
        </li>
        <li>
          <a href="#" class="primary-nav__sublink" data-list-type="follows">
            <svg class="primary-nav__sublink-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
              <circle cx="9" cy="7" r="4"></circle>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"></path>
            </svg>
            <span class="primary-nav__sublink-desc">Follows</span>
          </a>
        </li>
        <li>
          <a href="#" class="primary-nav__sublink" data-list-type="mutes">
            <svg class="primary-nav__sublink-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="1" y1="1" x2="23" y2="23"></line>
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
              <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
              <line x1="12" y1="19" x2="12" y2="23"></line>
              <line x1="8" y1="23" x2="16" y2="23"></line>
            </svg>
            <span class="primary-nav__sublink-desc">Muted</span>
          </a>
        </li>
        <li class="tribes-item" style="${isTribesEnabled() ? '' : 'display: none;'}">
          <a href="#" class="primary-nav__sublink" data-list-type="tribes">
            <svg class="primary-nav__sublink-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="6" cy="7" r="3"></circle>
              <circle cx="12" cy="7" r="3"></circle>
              <circle cx="18" cy="7" r="3"></circle>
              <path d="M3 19v-1a3 3 0 0 1 3-3h0a3 3 0 0 1 3 3v1"></path>
              <path d="M9 19v-1a3 3 0 0 1 3-3h0a3 3 0 0 1 3 3v1"></path>
              <path d="M15 19v-1a3 3 0 0 1 3-3h0a3 3 0 0 1 3 3v1"></path>
            </svg>
            <span class="primary-nav__sublink-desc">Tribes</span>
          </a>
        </li>
        ${PlatformService.getInstance().isAndroid ? '' : `
        <li class="nip51-inspector-item" style="${this.easterEggUnlocked ? '' : 'display: none;'}">
          <a href="#" class="primary-nav__sublink" data-list-type="nip51-inspector">
            <svg class="primary-nav__sublink-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <path d="M12 16v-4"></path>
              <path d="M12 8h.01"></path>
            </svg>
            <span class="primary-nav__sublink-desc">NIP-51 Inspector</span>
          </a>
        </li>
        `}
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

    // Setup easter egg listener if not already unlocked (skip on mobile — no keyboard)
    if (!this.easterEggUnlocked && !PlatformService.getInstance().isAndroid) {
      this.setupEasterEggListener();
    }

    return li;
  }

  /**
   * Setup global keypress listener for easter egg
   */
  private setupEasterEggListener(): void {
    this.keyListener = (e: KeyboardEvent) => {
      // Ignore if typing in an input field
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      this.easterEggBuffer += e.key.toLowerCase();

      // Keep buffer at max length of easter egg code
      if (this.easterEggBuffer.length > EASTER_EGG_CODE.length) {
        this.easterEggBuffer = this.easterEggBuffer.slice(-EASTER_EGG_CODE.length);
      }

      // Check if code matches
      if (this.easterEggBuffer === EASTER_EGG_CODE) {
        this.unlockEasterEgg();
      }
    };

    document.addEventListener('keydown', this.keyListener);
  }

  /**
   * Unlock the NIP-51 Inspector easter egg
   */
  private unlockEasterEgg(): void {
    this.easterEggUnlocked = true;
    sessionStorage.setItem(STORAGE_KEY, 'true');

    // Show the menu item
    const nip51Item = this.element?.querySelector('.nip51-inspector-item') as HTMLElement;
    if (nip51Item) {
      nip51Item.style.display = '';
    }

    // Expand the Lists menu to show it
    if (!this.isExpanded) {
      this.toggle();
    }

    // Show toast
    ToastService.show('NIP-51 Inspector unlocked!', 'success');

    // Remove listener
    if (this.keyListener) {
      document.removeEventListener('keydown', this.keyListener);
      this.keyListener = null;
    }
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
    if (this.keyListener) {
      document.removeEventListener('keydown', this.keyListener);
      this.keyListener = null;
    }
    this.element?.remove();
    this.element = null;
  }
}
