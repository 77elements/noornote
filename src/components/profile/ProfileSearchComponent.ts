/**
 * ProfileSearchComponent - Search trigger for profile pages
 * Uses ProfileModuleApi for client-side filtering
 */

import { ModuleLoader } from '../../core/ModuleLoader';
import type { ProfileModuleApi } from '../../modules/profile/contracts';
import { TypedEventBus } from '../../core/TypedEventBus';

export class ProfileSearchComponent {
  private container: HTMLElement;
  private pubkeyHex: string;
  private eventBus: TypedEventBus;
  private isExpanded: boolean = false;
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
  private clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

  constructor(pubkeyHex: string) {
    this.pubkeyHex = pubkeyHex;
    this.eventBus = TypedEventBus.getInstance();
    this.container = this.createElement();
    this.setupEventListeners();
  }

  /**
   * Create search component structure
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'profile-search';

    container.innerHTML = `
      <div class="profile-search__trigger">
        <a href="#" class="profile-search__link">Search in this npub</a>
      </div>
      <div class="profile-search__overlay is-hidden">
        <div class="profile-search__form">
          <input
            type="text"
            class="input"
            placeholder="Search terms..."
          />
          <button class="profile-search__btn btn-medium btn-passive" type="button">
            Search
          </button>
        </div>
        <div class="profile-search__status is-hidden"></div>
      </div>
    `;

    return container;
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    const link = this.container.querySelector('.profile-search__link');
    const input = this.container.querySelector('.input') as HTMLInputElement;
    const button = this.container.querySelector('.profile-search__btn');
    // Toggle search field
    link?.addEventListener('click', (e) => {
      e.preventDefault();
      this.expandSearch();
    });

    // Handle Enter key in input
    input?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.performSearch();
      }
    });

    // Handle search button click
    button?.addEventListener('click', () => {
      this.performSearch();
    });
  }

  /**
   * Expand search overlay
   */
  private expandSearch(): void {
    if (this.isExpanded) return;

    const trigger = this.container.querySelector('.profile-search__trigger') as HTMLElement;
    const overlay = this.container.querySelector('.profile-search__overlay') as HTMLElement;

    trigger.classList.add('is-hidden');
    overlay.classList.remove('is-hidden');
    this.isExpanded = true;

    // Focus input
    const input = this.container.querySelector('.input') as HTMLInputElement;
    setTimeout(() => input?.focus(), 100);

    // Add ESC key listener
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.collapseSearch();
      }
    };
    document.addEventListener('keydown', this.escapeHandler);

    // Close on click outside (delay to avoid catching the trigger click)
    setTimeout(() => {
      this.clickOutsideHandler = (e: MouseEvent) => {
        const overlayEl = this.container.querySelector('.profile-search__overlay');
        if (this.isExpanded && overlayEl && !overlayEl.contains(e.target as Node)) {
          this.collapseSearch();
        }
      };
      document.addEventListener('click', this.clickOutsideHandler);
    }, 0);
  }

  /**
   * Collapse search overlay
   */
  public collapseSearch(): void {
    if (!this.isExpanded) return;

    const trigger = this.container.querySelector('.profile-search__trigger') as HTMLElement;
    const overlay = this.container.querySelector('.profile-search__overlay') as HTMLElement;
    const input = this.container.querySelector('.input') as HTMLInputElement;

    overlay.classList.add('is-hidden');
    trigger.classList.remove('is-hidden');
    this.isExpanded = false;

    // Clear input
    if (input) input.value = '';

    // Remove listeners
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler);
      this.escapeHandler = null;
    }
    if (this.clickOutsideHandler) {
      document.removeEventListener('click', this.clickOutsideHandler);
      this.clickOutsideHandler = null;
    }
  }

  /**
   * Perform search
   */
  private async performSearch(): Promise<void> {
    const input = this.container.querySelector('.input') as HTMLInputElement;
    const button = this.container.querySelector('.profile-search__btn') as HTMLButtonElement;
    const searchTerms = input.value.trim();

    // Validation
    if (!searchTerms) return;

    try {
      // Disable button during search
      button.disabled = true;
      button.textContent = 'Searching...';

      const profileApi = ModuleLoader.getInstance().getApi<ProfileModuleApi>('profile');
      if (!profileApi) {
        throw new Error('Profile module not available');
      }

      // Perform search via ProfileModuleApi (fetches all notes, client-side filter)
      const result = await profileApi.searchUserNotes({
        pubkeyHex: this.pubkeyHex,
        searchTerms,
        onProgress: (message) => this.showStatus(message, 'info')
      });

      // Emit event with results for GlobalSearchView to display
      this.eventBus.emit('profileSearch:complete', {
        query: searchTerms,
        results: result.events,
        meta: `${result.matchCount} match${result.matchCount !== 1 ? 'es' : ''} found (searched ${result.totalNotes} note${result.totalNotes !== 1 ? 's' : ''} from ${result.dateRange.start} to ${result.dateRange.end})`
      });

      // Hide status
      this.hideStatus();

      // Reset button
      button.disabled = false;
      button.textContent = 'Search';

      // Collapse overlay
      this.collapseSearch();

    } catch (error) {
      console.error('[ProfileSearch] Search failed:', error);
      this.showStatus(`Search failed: ${error}`, 'error');
      button.disabled = false;
      button.textContent = 'Search';
    }
  }

  /**
   * Show status message
   */
  private showStatus(message: string, type: 'info' | 'error'): void {
    const status = this.container.querySelector('.profile-search__status') as HTMLElement;
    if (status) {
      status.textContent = message;
      status.className = `profile-search__status profile-search__status--${type}`;
      status.classList.remove('is-hidden');
    }
  }

  /**
   * Hide status message
   */
  private hideStatus(): void {
    const status = this.container.querySelector('.profile-search__status') as HTMLElement;
    if (status) {
      status.classList.add('is-hidden');
    }
  }

  /**
   * Get DOM element
   */
  public getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler);
    }
    if (this.clickOutsideHandler) {
      document.removeEventListener('click', this.clickOutsideHandler);
    }
    this.container.remove();
  }
}
