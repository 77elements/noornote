/**
 * UserSearchInput - Reusable user search input with dropdown
 * Provides user search (local follows + remote NIP-50) with autocomplete dropdown
 * Supports npub paste detection with automatic profile resolution
 *
 * @component UserSearchInput
 * @purpose Reusable user picker for DMs, mentions, etc.
 * @used-by DMComposeModal
 */

import { UserSearchService, type UserSearchResult } from '../../services/UserSearchService';
import { UserProfileService } from '../../services/UserProfileService';
import { renderUserMention, setupUserMentionHandlers } from '../../helpers/UserMentionHelper';
import { decodeNip19 } from '../../services/NostrToolsAdapter';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';

export interface UserSearchInputOptions {
  /** Placeholder text for input */
  placeholder?: string;
  /** Callback when user is selected */
  onUserSelected?: (pubkey: string, profile: UserSearchResult | null) => void;
  /** Callback when selection is cleared */
  onSelectionCleared?: () => void;
}

export class UserSearchInput {
  private container: HTMLElement;
  private inputElement: HTMLInputElement | null = null;
  private dropdownElement: HTMLElement | null = null;
  private selectedUserElement: HTMLElement | null = null;
  private userSearchService: UserSearchService;
  private userProfileService: UserProfileService;
  private options: UserSearchInputOptions;

  /** Current search results */
  private userResults: UserSearchResult[] = [];
  private isSearching: boolean = false;
  private selectedIndex: number = -1;

  /** Debounce timer for search */
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private currentSearchController: AbortController | null = null;

  /** Currently selected user */
  private selectedPubkey: string | null = null;

  constructor(options: UserSearchInputOptions = {}) {
    this.options = options;
    this.userSearchService = UserSearchService.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.container = this.createElement();
    this.setupEventListeners();
  }

  /**
   * Create the component structure
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'user-search-input';

    container.innerHTML = `
      <div class="user-search-input__selected" style="display: none;"></div>
      <div class="user-search-input__input-wrapper">
        <input
          type="text"
          class="input user-search-input__input"
          placeholder="${escapeHtml(this.options.placeholder || 'Search users...')}"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <div class="user-search-input__dropdown search-spotlight__user-suggestions" style="display: none;"></div>
    `;

    return container;
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    this.inputElement = this.container.querySelector('.user-search-input__input');
    this.dropdownElement = this.container.querySelector('.user-search-input__dropdown');
    this.selectedUserElement = this.container.querySelector('.user-search-input__selected');

    if (!this.inputElement) return;

    // Input changes trigger search
    this.inputElement.addEventListener('input', () => {
      this.selectedIndex = -1;
      this.debouncedSearch();
    });

    // Keyboard navigation
    this.inputElement.addEventListener('keydown', (e) => this.handleKeydown(e));

    // Paste handler for npub detection
    this.inputElement.addEventListener('paste', (e) => this.handlePaste(e));

    // Hide dropdown on blur (with delay for click)
    this.inputElement.addEventListener('blur', () => {
      setTimeout(() => this.hideDropdown(), 200);
    });

    // Show dropdown on focus if has results
    this.inputElement.addEventListener('focus', () => {
      if (this.userResults.length > 0 && !this.selectedPubkey) {
        this.showDropdown();
      }
    });
  }

  /**
   * Handle paste - detect npub and resolve profile
   */
  private async handlePaste(e: ClipboardEvent): Promise<void> {
    const pastedText = e.clipboardData?.getData('text')?.trim();
    if (!pastedText) return;

    // Check if pasted text is npub
    if (pastedText.startsWith('npub1') && pastedText.length === 63) {
      e.preventDefault();

      try {
        const decoded = decodeNip19(pastedText);
        if (decoded.type === 'npub') {
          const pubkey = decoded.data as string;

          // Show loading state in input
          if (this.inputElement) {
            this.inputElement.value = 'Loading profile...';
            this.inputElement.disabled = true;
          }

          // Fetch profile
          const profile = await this.userProfileService.getUserProfile(pubkey);

          // Create UserSearchResult from profile (exactOptionalPropertyTypes requires we omit undefined)
          const result: UserSearchResult = {
            pubkey,
            isFollowing: false,
            ...(profile?.name && { name: profile.name }),
            ...(profile?.display_name && { displayName: profile.display_name }),
            ...(profile?.picture && { picture: profile.picture }),
            ...(profile?.nip05 && { nip05: profile.nip05 })
          };

          // Select this user
          this.selectUser(result);
        }
      } catch (error) {
        // Invalid npub, let normal paste happen
        if (this.inputElement) {
          this.inputElement.value = pastedText;
          this.inputElement.disabled = false;
        }
      }
    }
  }

  /**
   * Handle keyboard navigation
   */
  private handleKeydown(e: KeyboardEvent): void {
    if (!this.dropdownElement || this.dropdownElement.style.display === 'none') {
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.navigateSelection('next');
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.navigateSelection('previous');
        break;
      case 'Enter': {
        e.preventDefault();
        const selectedUser = this.userResults[this.selectedIndex];
        if (selectedUser) {
          this.selectUser(selectedUser);
        }
        break;
      }
      case 'Escape':
        e.preventDefault();
        this.hideDropdown();
        break;
    }
  }

  /**
   * Debounced search (300ms delay)
   */
  private debouncedSearch(): void {
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }

    if (this.currentSearchController) {
      this.currentSearchController.abort();
    }

    const query = this.inputElement?.value.trim() || '';

    // Clear results if query too short
    if (query.length < 2) {
      this.userResults = [];
      this.isSearching = false;
      this.hideDropdown();
      return;
    }

    // Skip search for npub (handled by paste)
    if (query.startsWith('npub1')) {
      this.hideDropdown();
      return;
    }

    // Show loading state
    this.isSearching = true;
    this.showDropdown();
    this.renderDropdown();

    // Debounce
    this.searchDebounceTimer = setTimeout(() => {
      this.performSearch(query);
    }, 300);
  }

  /**
   * Perform user search
   */
  private performSearch(query: string): void {
    this.currentSearchController = this.userSearchService.search(query, {
      onLocalResults: (results) => {
        this.userResults = results;
        this.renderDropdown();
      },
      onRemoteResults: (results) => {
        // Add remote results (deduplicated)
        const existingPubkeys = new Set(this.userResults.map(r => r.pubkey));
        const newResults = results.filter(r => !existingPubkeys.has(r.pubkey));
        this.userResults = [...this.userResults, ...newResults];
        this.renderDropdown();
      },
      onComplete: () => {
        this.isSearching = false;
        this.renderDropdown();
      }
    });
  }

  /**
   * Show dropdown
   */
  private showDropdown(): void {
    if (this.dropdownElement) {
      this.dropdownElement.style.display = 'block';
    }
  }

  /**
   * Hide dropdown
   */
  private hideDropdown(): void {
    if (this.dropdownElement) {
      this.dropdownElement.style.display = 'none';
    }
  }

  /**
   * Render dropdown contents
   */
  private renderDropdown(): void {
    if (!this.dropdownElement) return;

    // Loading or empty state
    if (this.userResults.length === 0) {
      const message = this.isSearching ? 'Searching...' : 'No users found';
      this.dropdownElement.innerHTML = `
        <div class="search-spotlight__user-section">
          <div class="search-spotlight__user-header">Users</div>
          <div class="search-spotlight__user-loading">${message}</div>
        </div>
      `;
      return;
    }

    // Render user results
    const usersHtml = this.userResults.slice(0, 8).map((user, index) => {
      const displayName = user.displayName || user.name || 'Anonymous';
      const picture = user.picture || '';
      const followBadge = user.isFollowing ? '<span class="badge badge--accent">Following</span>' : '';
      const selectedClass = index === this.selectedIndex ? ' search-spotlight__suggestion--selected' : '';

      return `
        <div class="search-spotlight__user-item${selectedClass}" data-index="${index}">
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

    this.dropdownElement.innerHTML = `
      <div class="search-spotlight__user-section">
        <div class="search-spotlight__user-header">Users${this.isSearching ? ' (loading...)' : ''}</div>
        ${usersHtml}
      </div>
    `;

    // Add click handlers
    this.dropdownElement.querySelectorAll('.search-spotlight__user-item').forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt(item.getAttribute('data-index') || '0', 10);
        if (this.userResults[index]) {
          this.selectUser(this.userResults[index]);
        }
      });
    });
  }

  /**
   * Navigate selection in dropdown
   */
  private navigateSelection(direction: 'next' | 'previous'): void {
    if (this.userResults.length === 0) return;
    const maxIndex = this.userResults.length - 1;
    this.selectedIndex = direction === 'next'
      ? Math.min(this.selectedIndex + 1, maxIndex)
      : Math.max(this.selectedIndex - 1, 0);
    this.renderDropdown();
  }

  /**
   * Select a user
   */
  private selectUser(user: UserSearchResult): void {
    this.selectedPubkey = user.pubkey;

    // Hide input, show selected user chip
    if (this.inputElement) {
      this.inputElement.style.display = 'none';
      this.inputElement.disabled = false;
      this.inputElement.value = '';
    }

    if (this.selectedUserElement) {
      const displayName = user.displayName || user.name || 'Anonymous';
      const avatarUrl = user.picture || '';

      this.selectedUserElement.innerHTML = `
        <div class="user-search-input__chip">
          ${renderUserMention(user.pubkey, { username: displayName, avatarUrl })}
          <button class="user-search-input__clear" type="button" title="Remove">×</button>
        </div>
      `;
      this.selectedUserElement.style.display = 'block';

      // Setup hover card for the chip
      setupUserMentionHandlers(this.selectedUserElement);

      // Setup clear button
      const clearBtn = this.selectedUserElement.querySelector('.user-search-input__clear');
      clearBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.clearSelection();
      });
    }

    this.hideDropdown();
    this.userResults = [];

    this.options.onUserSelected?.(user.pubkey, user);
  }

  /**
   * Clear current selection
   */
  public clearSelection(): void {
    this.selectedPubkey = null;

    if (this.inputElement) {
      this.inputElement.style.display = 'block';
      this.inputElement.value = '';
      this.inputElement.focus();
    }

    if (this.selectedUserElement) {
      this.selectedUserElement.innerHTML = '';
      this.selectedUserElement.style.display = 'none';
    }

    this.options.onSelectionCleared?.();
  }

  /**
   * Get selected user pubkey
   */
  public getSelectedPubkey(): string | null {
    return this.selectedPubkey;
  }

  /**
   * Get DOM element
   */
  public getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Focus the input
   */
  public focus(): void {
    if (this.selectedPubkey) {
      // Already has selection, don't focus input
      return;
    }
    this.inputElement?.focus();
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    if (this.currentSearchController) {
      this.currentSearchController.abort();
    }
    this.container.remove();
  }
}
