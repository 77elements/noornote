/**
 * Search Spotlight
 * Spotlight-style modal for search and navigation
 * Includes user search (local follows + remote NIP-50)
 */

import { Router } from '../../services/Router';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { SearchModuleApi, UserSearchResult } from '../../modules/search/contracts';
import { hexToNpub } from '../../helpers/nip19';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { resolveNip05 } from '../../addons/nospress/Nip05Resolver';

/** Prefixes that bypass user search (the user clearly wants direct navigation, not a name match) */
const SPECIAL_INPUT_PREFIXES = ['/', 'http', 'npub1', 'nprofile1', 'nevent1', 'note1', 'naddr1', 'nostr:'] as const;

/** Loose NIP-05 shape check: "name@domain.tld" — full validation happens in the resolver */
function looksLikeNip05(input: string): boolean {
  const at = input.indexOf('@');
  if (at <= 0 || at >= input.length - 1) return false;
  const domain = input.slice(at + 1);
  if (!domain.includes('.')) return false;
  // Reject spaces or chars that obviously aren't part of an identifier
  return !/\s/.test(input);
}

export class SearchSpotlight {
  private element: HTMLElement;
  private router: Router;
  private eventBus: TypedEventBus;
  private _searchApi?: SearchModuleApi | null;
  private get searchApi(): SearchModuleApi | null {
    return this._searchApi ??= ModuleLoader.getInstance().getApi<SearchModuleApi>('search');
  }
  private isOpen: boolean = false;
  private inputElement: HTMLInputElement | null = null;
  private userSuggestionsElement: HTMLElement | null = null;
  private suggestionsElement: HTMLElement | null = null;
  private recentURLs: string[] = [];
  private escHandler: ((e: KeyboardEvent) => void) | null = null;
  private selectedSuggestionIndex: number = -1;

  /** Debounce timer for user search */
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private currentSearchController: AbortController | null = null;

  /** Current user search results */
  private userResults: UserSearchResult[] = [];
  private isSearchingUsers: boolean = false;

  constructor() {
    this.router = Router.getInstance();
    this.eventBus = TypedEventBus.getInstance();
    this.element = this.createElement();

    // ESC handler with capture phase - fires BEFORE ModalService ESC handler
    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.isOpen) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.close();
      }
    };
    document.addEventListener('keydown', this.escHandler, { capture: true });

    this.setupEventListeners();
  }

  private createElement(): HTMLElement {
    const modal = document.createElement('div');
    modal.className = 'search-spotlight';

    modal.innerHTML = `
      <div class="search-spotlight__overlay"></div>
      <div class="search-spotlight__content">
        <div class="search-spotlight__input-wrapper">
          <input
            type="text"
            class="input input--monospace"
            placeholder="Enter URL path (e.g., /profile, /note/...)"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div class="search-spotlight__controls">
          <button class="search-spotlight__btn search-spotlight__btn--back" title="Go Back (Cmd+ArrowLeft)" disabled>
            <span class="chevron-left"></span>
            Back
          </button>
          <button class="search-spotlight__btn search-spotlight__btn--forward" title="Go Forward (Cmd+ArrowRight)" disabled>
            Forward
            <span class="chevron-right"></span>
          </button>
        </div>
        <div class="search-spotlight__user-suggestions"></div>
        <div class="search-spotlight__suggestions"></div>
      </div>
    `;

    return modal;
  }

  private setupEventListeners(): void {
    // Overlay click to close
    const overlay = this.element.querySelector('.search-spotlight__overlay');
    overlay?.addEventListener('click', () => this.close());

    // Input element
    this.inputElement = this.element.querySelector('.input');

    if (this.inputElement) {
      // Keyboard navigation for input
      this.inputElement.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.navigateToSelectedOrInput();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.selectNextSuggestion();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.selectPreviousSuggestion();
        }
      });

      // Input changes for suggestions
      this.inputElement.addEventListener('input', () => {
        this.selectedSuggestionIndex = -1;
        this.updateSuggestions();
        this.debouncedUserSearch();
      });
    }

    // Back/Forward buttons
    const backBtn = this.element.querySelector('.search-spotlight__btn--back');
    const forwardBtn = this.element.querySelector('.search-spotlight__btn--forward');

    backBtn?.addEventListener('click', () => {
      this.router.back();
      this.updateNavigationButtons();
    });

    forwardBtn?.addEventListener('click', () => {
      this.router.forward();
      this.updateNavigationButtons();
    });

    // User suggestions element
    this.userSuggestionsElement = this.element.querySelector('.search-spotlight__user-suggestions');

    // URL suggestions element
    this.suggestionsElement = this.element.querySelector('.search-spotlight__suggestions');
  }

  public open(): void {
    if (this.isOpen) return;

    this.isOpen = true;
    document.body.appendChild(this.element);

    // Load recent URLs from history
    this.recentURLs = this.router.getHistory();

    // Update navigation buttons state
    this.updateNavigationButtons();

    // Reset user results
    this.userResults = [];
    this.isSearchingUsers = false;

    // Set placeholder
    if (this.inputElement) {
      this.inputElement.value = '';
      this.inputElement.placeholder = 'Search: (npub / nevent / username / full text)';
      this.inputElement.focus();
    }

    // Show suggestions
    this.updateSuggestions();
    this.updateUserSuggestions();
  }

  public close(): void {
    if (!this.isOpen) return;

    this.isOpen = false;
    this.element.remove();
    this.cancelPendingSearch();

    if (this.inputElement) {
      this.inputElement.value = '';
    }

    this.selectedSuggestionIndex = -1;
    this.userResults = [];
  }

  /** Cancel any pending search operation */
  private cancelPendingSearch(): void {
    if (this.currentSearchController) {
      this.currentSearchController.abort();
      this.currentSearchController = null;
    }
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
  }

  public toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /** Check if input starts with a special prefix that bypasses user search */
  private isSpecialInput(query: string): boolean {
    return SPECIAL_INPUT_PREFIXES.some(prefix => query.startsWith(prefix));
  }

  /** Debounced user search (300ms delay) */
  private debouncedUserSearch(): void {
    this.cancelPendingSearch();

    const query = this.inputElement?.value.trim() || '';

    // Clear results if query too short or special input
    if (query.length < 2 || this.isSpecialInput(query)) {
      this.userResults = [];
      this.isSearchingUsers = false;
      this.updateUserSuggestions();
      return;
    }

    // Show loading state
    this.isSearchingUsers = true;
    this.updateUserSuggestions();

    // Debounce
    this.searchDebounceTimer = setTimeout(() => {
      this.performUserSearch(query);
    }, 300);
  }

  /**
   * Perform user search (local + remote)
   */
  private performUserSearch(query: string): void {
    this.currentSearchController = this.searchApi?.searchUsers(query, {
      onLocalResults: (results) => {
        // Merge local results (they come first)
        this.userResults = results;
        this.updateUserSuggestions();
      },
      onRemoteResults: (results) => {
        // Add remote results (deduplicated in service)
        const existingPubkeys = new Set(this.userResults.map(r => r.pubkey));
        const newResults = results.filter(r => !existingPubkeys.has(r.pubkey));
        this.userResults = [...this.userResults, ...newResults];
        this.updateUserSuggestions();
      },
      onComplete: () => {
        this.isSearchingUsers = false;
        this.updateUserSuggestions();
      }
    }) ?? null;
  }

  /** Update user suggestions display */
  private updateUserSuggestions(): void {
    if (!this.userSuggestionsElement) return;

    const query = this.inputElement?.value.trim() || '';

    // Hide if no query, too short, or special input
    if (query.length < 2 || this.isSpecialInput(query)) {
      this.userSuggestionsElement.innerHTML = '';
      return;
    }

    // No results state
    if (this.userResults.length === 0) {
      this.userSuggestionsElement.innerHTML = this.isSearchingUsers
        ? `<div class="search-spotlight__user-section">
            <div class="search-spotlight__user-header">Users</div>
            <div class="search-spotlight__user-loading pulsate">Searching...</div>
          </div>`
        : '';
      return;
    }

    // Render user results
    const usersHtml = this.userResults.slice(0, 8).map((user, index) => {
      const displayName = user.displayName || user.name || 'Anonymous';
      const picture = user.picture || '';
      const followBadge = user.isFollowing ? '<span class="badge badge--accent">Following</span>' : '';

      return `
        <div class="search-spotlight__user-item" data-pubkey="${user.pubkey}" data-user-index="${index}">
          <div class="search-spotlight__user-avatar">
            ${picture ? `<img src="${escapeHtmlAttr(picture)}" alt="" loading="lazy" />` : '<div class="search-spotlight__user-avatar-placeholder"></div>'}
          </div>
          <div class="search-spotlight__user-info">
            <span class="search-spotlight__user-name">${escapeHtml(displayName)}</span>
            ${user.nip05 ? `<span class="search-spotlight__user-nip05">${escapeHtml(user.nip05)}</span>` : ''}
          </div>
          ${followBadge}
        </div>
      `;
    }).join('');

    this.userSuggestionsElement.innerHTML = `
      <div class="search-spotlight__user-section">
        <div class="search-spotlight__user-header">Users${this.isSearchingUsers ? ' <span class="pulsate">(loading…)</span>' : ''}</div>
        ${usersHtml}
      </div>
    `;

    // Add click handlers
    this.userSuggestionsElement.querySelectorAll('.search-spotlight__user-item').forEach(item => {
      item.addEventListener('click', () => {
        const pubkey = item.getAttribute('data-pubkey');
        if (pubkey) {
          const npub = hexToNpub(pubkey);
          this.router.navigate(`/profile/${npub}`);
          this.close();
        }
      });
    });
  }

  private async navigateToInputURL(): Promise<void> {
    const raw = this.inputElement?.value.trim();
    if (!raw) return;

    // Strip the optional NIP-21 `nostr:` URI prefix so identifiers behind it
    // ("nostr:npub1…", "nostr:nevent1…") route the same as bare ones.
    const input = raw.replace(/^nostr:/, '');
    const route = this.resolveInputRoute(input);

    if (route === null) {
      // External URL - open in system browser
      await this.openExternalURL(input);
    } else if (route) {
      // Internal route
      this.router.navigate(route);
    } else if (looksLikeNip05(input)) {
      // NIP-05 identifier ("alice@domain.tld") — resolve to pubkey and navigate.
      // On failure, fall through to full-text search so the user still gets a result.
      const resolved = await resolveNip05(input);
      if (resolved?.pubkey) {
        const npub = hexToNpub(resolved.pubkey);
        if (npub) {
          this.router.navigate(`/profile/${npub}`);
          this.close();
          return;
        }
      }
      this.eventBus.emit('globalSearch:start', { query: input });
    } else {
      // No route resolved - treat as full-text search
      this.eventBus.emit('globalSearch:start', { query: input });
    }

    this.close();
  }

  /** Resolve input to an internal route, null for external URL, or empty string for search */
  private resolveInputRoute(input: string): string | null {
    if (input.startsWith('http://') || input.startsWith('https://')) {
      return null; // External URL
    }
    // Profile identifiers: npub (bare 63-char) and nprofile (variable length, carries relay hints)
    if ((input.startsWith('npub1') && input.length === 63) || input.startsWith('nprofile1')) {
      return `/profile/${input}`;
    }
    // Event identifiers: note (bare, 63-char) and nevent (with relay hints). SNV decodes both.
    if (input.startsWith('nevent1') || input.startsWith('note1')) {
      return `/note/${input}`;
    }
    // Addressable events (kind 30000–39999): articles, listings, follow packs, …
    // The single-note route also handles naddr via App.getRouteForAddressableEvent
    // for known kinds, but lacking the kind context here we fall back to /note/.
    if (input.startsWith('naddr1')) {
      return `/note/${input}`;
    }
    if (input.startsWith('/')) {
      return input;
    }
    return ''; // Empty string signals search query (or NIP-05 attempt upstream)
  }

  /**
   * Open external URL in system default browser
   */
  private async openExternalURL(url: string): Promise<void> {
    try {
      const { PlatformService } = await import('../../services/PlatformService');
      const _p = PlatformService.getInstance();
      if (_p.isElectron) {
        await window.electronAPI!.openExternal(url);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } catch (error) {
      console.error('Failed to open external URL:', error);
    }
  }

  private updateNavigationButtons(): void {
    const backBtn = this.element.querySelector('.search-spotlight__btn--back') as HTMLButtonElement;
    const forwardBtn = this.element.querySelector('.search-spotlight__btn--forward') as HTMLButtonElement;

    if (backBtn) {
      backBtn.disabled = !this.router.canGoBack();
    }

    if (forwardBtn) {
      forwardBtn.disabled = !this.router.canGoForward();
    }
  }

  private updateSuggestions(): void {
    if (!this.suggestionsElement || !this.inputElement) return;

    const query = this.inputElement.value.trim().toLowerCase();

    // Filter recent URLs based on query
    let suggestions: string[];
    if (query) {
      suggestions = this.recentURLs.filter(url =>
        url.toLowerCase().includes(query)
      );
    } else {
      // Show all recent URLs (reversed, most recent first)
      suggestions = [...this.recentURLs].reverse().slice(0, 10);
    }

    // Remove duplicates and current path
    const currentPath = this.router.getCurrentPath();
    suggestions = [...new Set(suggestions)].filter(url => url !== currentPath);

    // Render suggestions
    if (suggestions.length === 0) {
      this.suggestionsElement.innerHTML = '<div class="search-spotlight__empty">No recent URLs</div>';
      return;
    }

    this.suggestionsElement.innerHTML = suggestions
      .map((url, index) => `
        <div class="search-spotlight__suggestion" data-url="${url}" data-index="${index}">
          <svg class="search-spotlight__suggestion-icon"><use href="#icon-search-clock"/></svg>
          <span class="search-spotlight__suggestion-text">${url}</span>
        </div>
      `)
      .join('');

    // Add click handlers to suggestions
    this.suggestionsElement.querySelectorAll('.search-spotlight__suggestion').forEach(item => {
      item.addEventListener('click', () => {
        const url = item.getAttribute('data-url');
        if (url) {
          this.router.navigate(url);
          this.close();
        }
      });
    });
  }

  private selectNextSuggestion(): void {
    const focusableElements = this.getFocusableElements();
    if (focusableElements.length === 0) return;

    this.selectedSuggestionIndex = Math.min(this.selectedSuggestionIndex + 1, focusableElements.length - 1);
    this.updateSelectedSuggestion();
  }

  private selectPreviousSuggestion(): void {
    const focusableElements = this.getFocusableElements();
    if (focusableElements.length === 0) return;

    this.selectedSuggestionIndex = Math.max(this.selectedSuggestionIndex - 1, -1);
    this.updateSelectedSuggestion();
  }

  private getFocusableElements(): Element[] {
    const elements: Element[] = [];

    // Add Back/Forward buttons
    const backBtn = this.element.querySelector('.search-spotlight__btn--back:not(:disabled)');
    const forwardBtn = this.element.querySelector('.search-spotlight__btn--forward:not(:disabled)');

    if (backBtn) elements.push(backBtn);
    if (forwardBtn) elements.push(forwardBtn);

    // Add user suggestions
    if (this.userSuggestionsElement) {
      const userItems = this.userSuggestionsElement.querySelectorAll('.search-spotlight__user-item');
      elements.push(...Array.from(userItems));
    }

    // Add URL suggestions
    if (this.suggestionsElement) {
      const suggestions = this.suggestionsElement.querySelectorAll('.search-spotlight__suggestion');
      elements.push(...Array.from(suggestions));
    }

    return elements;
  }

  private updateSelectedSuggestion(): void {
    const focusableElements = this.getFocusableElements();

    focusableElements.forEach((item, index) => {
      if (index === this.selectedSuggestionIndex) {
        item.classList.add('search-spotlight__suggestion--selected');
        item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        item.classList.remove('search-spotlight__suggestion--selected');
      }
    });
  }

  private navigateToSelectedOrInput(): void {
    // If an element is selected, trigger its action
    if (this.selectedSuggestionIndex >= 0) {
      const focusableElements = this.getFocusableElements();
      const selectedElement = focusableElements[this.selectedSuggestionIndex];

      if (selectedElement) {
        // Check if it's a button (Back/Forward)
        if (selectedElement instanceof HTMLButtonElement) {
          selectedElement.click();
          this.updateNavigationButtons();
          return;
        }

        // Check if it's a user item
        const pubkey = selectedElement.getAttribute('data-pubkey');
        if (pubkey) {
          const npub = hexToNpub(pubkey);
          this.router.navigate(`/profile/${npub}`);
          this.close();
          return;
        }

        // Check if it's a URL suggestion
        const url = selectedElement.getAttribute('data-url');
        if (url) {
          this.router.navigate(url);
          this.close();
          return;
        }
      }
    }

    // Otherwise, navigate to input value
    this.navigateToInputURL();
  }


  public destroy(): void {
    if (this.escHandler) {
      document.removeEventListener('keydown', this.escHandler, { capture: true });
    }
    this.cancelPendingSearch();
    this.element.remove();
  }
}
