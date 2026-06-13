/**
 * CustomEmojiAutocomplete
 *
 * Inline shortcode autocomplete for textareas. Triggers on `:` followed by
 * one or more characters and floats a dropdown with matching emojis from the
 * user's personal NIP-30 pack.
 *
 * Mirrors the behaviour of MentionAutocomplete (`@username`) but for `:shortcode:`.
 *
 * Heavy by design — only loaded via dynamic import when the Custom Emojis
 * addon is enabled.
 */

import { EmojiService, type PersonalEmoji } from './EmojiService';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';

export interface CustomEmojiAutocompleteOptions {
  textareaSelector: string;
  onEmojiInserted?: (shortcode: string) => void;
}

export class CustomEmojiAutocomplete {
  private dropdown: HTMLElement | null = null;
  private suggestions: PersonalEmoji[] = [];
  private selectedIndex: number = 0;
  private isActive: boolean = false;
  private triggerStartPos: number = 0;
  private searchQuery: string = '';

  // Delegated handlers — bound to document so we survive textarea cloneNode/replace
  private inputHandler: ((e: Event) => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private focusoutHandler: ((e: FocusEvent) => void) | null = null;

  constructor(private options: CustomEmojiAutocompleteOptions) {}

  /** Resolve the live textarea via the configured selector. */
  private getTextarea(): HTMLTextAreaElement | null {
    return document.querySelector<HTMLTextAreaElement>(this.options.textareaSelector);
  }

  /** Initialise event delegation. Idempotent — safe to call repeatedly. */
  public init(): void {
    if (this.inputHandler) return; // already wired

    // Pre-warm the service so the first lookup is synchronous
    void EmojiService.getInstance().refreshFromRelays();

    this.inputHandler = (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches?.(this.options.textareaSelector)) this.handleInput();
    };
    this.keydownHandler = (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches?.(this.options.textareaSelector)) this.handleKeydown(e);
    };
    this.focusoutHandler = (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches?.(this.options.textareaSelector)) {
        setTimeout(() => this.hide(), 200);
      }
    };

    document.addEventListener('input', this.inputHandler, true);
    document.addEventListener('keydown', this.keydownHandler, true);
    document.addEventListener('focusout', this.focusoutHandler, true);
  }

  // ── Trigger detection ───────────────────────────────────────────

  private handleInput(): void {
    const textarea = this.getTextarea();
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBeforeCursor = textarea.value.substring(0, cursorPos);
    const lastColonIndex = textBeforeCursor.lastIndexOf(':');

    if (lastColonIndex === -1) {
      this.hide();
      return;
    }

    // The colon must sit at a word boundary (start of text, space, newline)
    const charBeforeColon = lastColonIndex > 0 ? textBeforeCursor[lastColonIndex - 1] : ' ';
    if (charBeforeColon !== ' ' && charBeforeColon !== '\n') {
      this.hide();
      return;
    }

    const textAfterColon = textBeforeCursor.substring(lastColonIndex + 1);

    // If there's a closing colon, space, or newline → not in trigger mode
    if (textAfterColon.includes(' ') || textAfterColon.includes('\n') || textAfterColon.includes(':')) {
      this.hide();
      return;
    }

    // Need at least one character before showing
    if (textAfterColon.length < 1) {
      this.hide();
      return;
    }

    this.triggerStartPos = lastColonIndex;
    this.searchQuery = textAfterColon.toLowerCase();
    this.show(textarea);
  }

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
      case 'Enter':
      case 'Tab':
        const selected = this.suggestions[this.selectedIndex];
        if (selected) {
          e.preventDefault();
          this.insertEmoji(selected);
        }
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        this.hide();
        break;
    }
  }

  // ── Filter + render ─────────────────────────────────────────────

  private show(textarea: HTMLTextAreaElement): void {
    const all = EmojiService.getInstance().getEmojis();
    if (all.length === 0) {
      this.hide();
      return;
    }

    this.suggestions = all
      .filter(e => e.shortcode.toLowerCase().includes(this.searchQuery))
      .slice(0, 12);

    if (this.suggestions.length === 0) {
      this.hide();
      return;
    }

    this.selectedIndex = 0;
    this.isActive = true;
    this.render(textarea);
  }

  private render(textarea: HTMLTextAreaElement): void {
    if (this.dropdown) this.dropdown.remove();

    this.dropdown = document.createElement('div');
    this.dropdown.className = 'custom-emojis__autocomplete';

    this.suggestions.forEach((emoji, index) => {
      const item = document.createElement('div');
      item.className = `custom-emojis__autocomplete-item ${index === this.selectedIndex ? 'selected' : ''}`;
      item.dataset.index = String(index);
      const safeUrl = escapeHtmlAttr(emoji.url);
      item.innerHTML = `
        <img class="custom-emoji" src="${safeUrl}" alt=":${escapeHtml(emoji.shortcode)}:" loading="lazy" />
        <span class="custom-emojis__autocomplete-code">:${escapeHtml(emoji.shortcode)}:</span>
      `;
      item.addEventListener('mousedown', (e) => {
        // mousedown so the textarea blur handler doesn't kill us first
        e.preventDefault();
        this.insertEmoji(emoji);
      });
      this.dropdown!.appendChild(item);
    });

    this.positionDropdown(textarea);
    document.body.appendChild(this.dropdown);
  }

  private updateSelection(): void {
    if (!this.dropdown) return;
    this.dropdown.querySelectorAll<HTMLElement>('.custom-emojis__autocomplete-item').forEach((el, i) => {
      if (i === this.selectedIndex) {
        el.classList.add('selected');
        el.scrollIntoView({ block: 'nearest' });
      } else {
        el.classList.remove('selected');
      }
    });
  }

  private selectNext(): void {
    if (this.suggestions.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.suggestions.length;
    this.updateSelection();
  }

  private selectPrevious(): void {
    if (this.suggestions.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + this.suggestions.length) % this.suggestions.length;
    this.updateSelection();
  }

  // ── Positioning (mirror-div technique) ──────────────────────────

  private positionDropdown(textarea: HTMLTextAreaElement): void {
    if (!this.dropdown) return;

    const textareaRect = textarea.getBoundingClientRect();
    const cursorCoords = this.getCursorCoordinates(textarea);

    this.dropdown.style.position = 'fixed';
    this.dropdown.style.left = `${textareaRect.left + cursorCoords.left}px`;
    this.dropdown.style.top = `${textareaRect.top + cursorCoords.top + cursorCoords.height + 5}px`;
    this.dropdown.style.zIndex = '10000';
  }

  private getCursorCoordinates(textarea: HTMLTextAreaElement): { left: number; top: number; height: number } {
    const mirror = document.createElement('div');
    const computedStyle = window.getComputedStyle(textarea);

    [
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
      'letterSpacing', 'lineHeight', 'textTransform',
      'wordSpacing', 'wordWrap', 'whiteSpace',
      'padding', 'border', 'boxSizing'
    ].forEach(prop => {
      const value = computedStyle[prop as any];
      if (value !== undefined) {
        mirror.style[prop as any] = value;
      }
    });

    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.height = 'auto';

    document.body.appendChild(mirror);

    const textUpToTrigger = textarea.value.substring(0, this.triggerStartPos);
    mirror.textContent = textUpToTrigger;

    const triggerSpan = document.createElement('span');
    triggerSpan.textContent = ':';
    mirror.appendChild(triggerSpan);

    const triggerRect = triggerSpan.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();

    const left = triggerRect.left - mirrorRect.left;
    const top = triggerRect.top - mirrorRect.top;
    const height = triggerRect.height;

    document.body.removeChild(mirror);

    return { left, top, height };
  }

  // ── Insert + cleanup ────────────────────────────────────────────

  private insertEmoji(emoji: PersonalEmoji): void {
    const textarea = this.getTextarea();
    if (!textarea) return;

    const textBefore = textarea.value.substring(0, this.triggerStartPos);
    const textAfter = textarea.value.substring(textarea.selectionStart);

    const replacement = `:${emoji.shortcode}: `;
    const newText = textBefore + replacement + textAfter;
    textarea.value = newText;

    const newCursorPos = textBefore.length + replacement.length;
    textarea.setSelectionRange(newCursorPos, newCursorPos);
    textarea.focus();

    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    this.options.onEmojiInserted?.(emoji.shortcode);
    this.hide();
  }

  private hide(): void {
    this.isActive = false;
    if (this.dropdown) {
      this.dropdown.remove();
      this.dropdown = null;
    }
  }

  public destroy(): void {
    this.hide();
    if (this.inputHandler) document.removeEventListener('input', this.inputHandler, true);
    if (this.keydownHandler) document.removeEventListener('keydown', this.keydownHandler, true);
    if (this.focusoutHandler) document.removeEventListener('focusout', this.focusoutHandler, true);
    this.inputHandler = null;
    this.keydownHandler = null;
    this.focusoutHandler = null;
  }
}
