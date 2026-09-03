/**
 * MentionAutocomplete Component
 * Autocomplete dropdown for @mentions in textarea
 *
 * Features:
 * - Triggers on "@" character
 * - Filters follow list by username
 * - Shows profile picture + username + display name
 * - Keyboard navigation (ArrowUp/Down, Enter, Escape)
 * - Inserts nostr:npub mention on selection
 *
 * Used by: PostNoteModal, ReplyModal
 */

import { AppState } from '../../services/AppState';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { PostsModuleApi } from '../../modules/posts/contracts';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import {
  measureCursorCoordinates,
  positionDropdownAtCaret,
} from './autocompleteShared';

export interface MentionSuggestion {
  pubkey: string;
  npub: string;
  username: string;
  displayName: string;
  picture: string;
  nip05?: string;
}

export interface MentionAutocompleteOptions {
  textareaSelector: string;
  onMentionInserted?: (npub: string, username: string) => void;
}

export class MentionAutocomplete {
  private textarea: HTMLTextAreaElement | null = null;
  private dropdown: HTMLElement | null = null;
  private suggestions: MentionSuggestion[] = [];
  private selectedIndex: number = 0;
  private isActive: boolean = false;
  private mentionStartPos: number = 0;
  private searchQuery: string = '';

  private appState: AppState;
  private options: MentionAutocompleteOptions;

  constructor(options: MentionAutocompleteOptions) {
    this.options = options;
    this.appState = AppState.getInstance();
  }

  /**
   * Initialize autocomplete on a textarea or single-line input.
   *
   * Note: HTMLInputElement is structurally compatible with HTMLTextAreaElement
   * for our needs (value / selectionStart / setSelectionRange), so we cast
   * either to HTMLTextAreaElement here. Callers pass any selector that
   * matches a textarea OR an <input type="text">.
   */
  public init(): void {
    this.textarea = document.querySelector(
      this.options.textareaSelector
    ) as HTMLTextAreaElement | null;
    if (!this.textarea) return;

    this.textarea.addEventListener('input', e => this.handleInput(e));
    this.textarea.addEventListener('keydown', e => this.handleKeydown(e));
    this.textarea.addEventListener('paste', e => this.handlePaste(e));

    // Close dropdown on blur (with delay to allow clicks)
    this.textarea.addEventListener('blur', () => {
      setTimeout(() => this.hide(), 200);
    });
  }

  /**
   * Handle textarea input - detect @ trigger
   */
  private handleInput(_e: Event): void {
    if (!this.textarea) return;

    const cursorPos = this.textarea.selectionStart;
    const textBeforeCursor = this.textarea.value.substring(0, cursorPos);

    // Find last @ before cursor
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    if (lastAtIndex === -1) {
      this.hide();
      return;
    }

    // Check if @ is at word boundary (start of line or after space/newline)
    const charBeforeAt =
      lastAtIndex > 0 ? textBeforeCursor[lastAtIndex - 1] : ' ';
    if (charBeforeAt !== ' ' && charBeforeAt !== '\n') {
      this.hide();
      return;
    }

    // Extract search query after @
    const textAfterAt = textBeforeCursor.substring(lastAtIndex + 1);

    // Check if there's a space after @ (mention completed)
    if (textAfterAt.includes(' ') || textAfterAt.includes('\n')) {
      this.hide();
      return;
    }

    // Require at least 2 characters before fetching profiles (performance optimization)
    if (textAfterAt.length < 2) {
      this.hide();
      return;
    }

    // Trigger autocomplete
    this.mentionStartPos = lastAtIndex;
    this.searchQuery = textAfterAt.toLowerCase();
    void this.show();
  }

  /**
   * Handle paste event - auto-convert raw npub to nostr:npub format
   */
  private handlePaste(e: ClipboardEvent): void {
    if (!this.textarea) return;

    const pastedText = e.clipboardData?.getData('text');
    if (!pastedText) return;

    // Check if pasted text contains raw npub (standalone, not already prefixed)
    const npubPattern = /^npub1[a-z0-9]{58}$/;

    if (npubPattern.test(pastedText.trim())) {
      e.preventDefault();

      const cursorPos = this.textarea.selectionStart;
      const textBefore = this.textarea.value.substring(0, cursorPos);
      const textAfter = this.textarea.value.substring(
        this.textarea.selectionEnd
      );

      // Convert to nostr:npub format
      const convertedText = `nostr:${pastedText.trim()}`;
      this.textarea.value = textBefore + convertedText + textAfter;

      // Set cursor after inserted text
      const newCursorPos = cursorPos + convertedText.length;
      this.textarea.setSelectionRange(newCursorPos, newCursorPos);

      // Trigger input event for preview update
      this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  /**
   * Handle keyboard navigation
   */
  private handleKeydown(e: KeyboardEvent): void {
    if (!this.isActive) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.selectNext();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.selectPrevious();
        break;
      case 'Enter': {
        const selected = this.suggestions[this.selectedIndex];
        if (selected) {
          e.preventDefault();
          this.insertMention(selected);
        }
        break;
      }
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        this.hide();
        break;
    }
  }

  /**
   * Show dropdown with filtered suggestions
   */
  private async show(): Promise<void> {
    // Get follow list from AppState
    const userState = this.appState.getState('user');
    const followingPubkeys = userState.followingPubkeys;

    if (followingPubkeys.length === 0) {
      this.hide();
      return;
    }

    // Get suggestions from global cache (instant if preloaded at login)
    const postsApi = ModuleLoader.getInstance().getApi<PostsModuleApi>('posts');
    const allSuggestions =
      (await postsApi?.getMentionSuggestions(followingPubkeys)) ?? [];

    if (allSuggestions.length === 0) {
      this.hide();
      return;
    }

    // Filter by search query (match against username, displayName, or nip05)
    this.suggestions = allSuggestions.filter(suggestion => {
      if (!this.searchQuery) return true;

      const query = this.searchQuery.toLowerCase();
      const username = suggestion.username.toLowerCase();
      const displayName = suggestion.displayName.toLowerCase();
      const nip05 = (suggestion.nip05 || '').toLowerCase();

      return (
        username.includes(query) ||
        displayName.includes(query) ||
        nip05.includes(query)
      );
    });

    if (this.suggestions.length === 0) {
      this.hide();
      return;
    }

    this.selectedIndex = 0;
    this.isActive = true;
    this.render();
  }

  /**
   * Render dropdown UI
   */
  private render(): void {
    if (!this.textarea) return;

    // Remove existing dropdown
    if (this.dropdown) {
      this.dropdown.remove();
    }

    // Create dropdown
    this.dropdown = document.createElement('div');
    this.dropdown.className = 'mention-autocomplete';

    // Render suggestions
    this.suggestions.forEach((suggestion, index) => {
      const item = document.createElement('div');
      item.className = `mention-item ${index === this.selectedIndex ? 'selected' : ''}`;
      item.dataset.index = String(index);

      item.innerHTML = `
        <img
          src="${escapeHtmlAttr(suggestion.picture || '')}"
          alt="${escapeHtmlAttr(suggestion.username)}"
          class="mention-avatar"
        />
        <div class="mention-info">
          <div class="mention-name">${escapeHtml(suggestion.displayName)}</div>
          <div class="mention-username">@${escapeHtml(suggestion.username)}</div>
          ${suggestion.nip05 ? `<div class="mention-nip05">${escapeHtml(suggestion.nip05)}</div>` : ''}
        </div>
      `;

      item.addEventListener('click', () => this.insertMention(suggestion));
      this.dropdown!.appendChild(item);
    });

    // Position dropdown below cursor
    this.positionDropdown();

    // Append to body
    document.body.appendChild(this.dropdown);
  }

  /**
   * Position dropdown below @ character
   * Uses mirror div technique for accurate cursor position
   */
  private positionDropdown(): void {
    if (!this.textarea || !this.dropdown) return;

    const cursorCoords = this.getCursorCoordinates();
    positionDropdownAtCaret(this.dropdown, this.textarea, cursorCoords);
  }

  /**
   * Get cursor coordinates relative to textarea
   * Uses mirror div technique for accurate positioning
   */
  private getCursorCoordinates(): {
    left: number;
    top: number;
    height: number;
  } {
    if (!this.textarea) return { left: 0, top: 0, height: 20 };
    return measureCursorCoordinates(this.textarea, this.mentionStartPos, '@');
  }

  /**
   * Select next suggestion
   */
  private selectNext(): void {
    if (this.suggestions.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.suggestions.length;
    this.updateSelection();
  }

  /**
   * Select previous suggestion
   */
  private selectPrevious(): void {
    if (this.suggestions.length === 0) return;
    this.selectedIndex =
      (this.selectedIndex - 1 + this.suggestions.length) %
      this.suggestions.length;
    this.updateSelection();
  }

  /**
   * Update visual selection
   */
  private updateSelection(): void {
    if (!this.dropdown) return;

    const items = this.dropdown.querySelectorAll('.mention-item');
    items.forEach((item, index) => {
      if (index === this.selectedIndex) {
        item.classList.add('selected');
        item.scrollIntoView({ block: 'nearest' });
      } else {
        item.classList.remove('selected');
      }
    });
  }

  /**
   * Insert selected mention into textarea
   */
  private insertMention(suggestion: MentionSuggestion): void {
    if (!this.textarea) return;

    const textBefore = this.textarea.value.substring(0, this.mentionStartPos);
    const textAfter = this.textarea.value.substring(
      this.textarea.selectionStart
    );

    // Insert nostr:npub format (will be converted to @username in preview/render)
    const mention = `nostr:${suggestion.npub}`;
    const newText = `${textBefore + mention} ${textAfter}`;

    this.textarea.value = newText;

    // Update cursor position
    const newCursorPos = textBefore.length + mention.length + 1;
    this.textarea.setSelectionRange(newCursorPos, newCursorPos);
    this.textarea.focus();

    // Trigger input event for content update
    this.textarea.dispatchEvent(new Event('input', { bubbles: true }));

    // Callback
    if (this.options.onMentionInserted) {
      this.options.onMentionInserted(suggestion.npub, suggestion.username);
    }

    this.hide();
  }

  /**
   * Hide dropdown
   */
  private hide(): void {
    this.isActive = false;
    if (this.dropdown) {
      this.dropdown.remove();
      this.dropdown = null;
    }
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    this.hide();
    // Event listeners are cleaned up when textarea is removed from DOM
  }
}
