/**
 * ProfileSearchComponent - Inline trigger + overlay for search-style UIs.
 *
 * Originally built for ProfileView ("Search in this user's timeline"). Now
 * option-driven so it can be reused wherever a small inline overlay with an
 * input + button is needed (e.g. image-tagging in the New Note Modal).
 *
 * Two size variants:
 *   - 'inline-icon-row'  (default): bigger paddings/font, used in ProfileView header.
 *   - 'compact-modal'              : smaller paddings/font, used in tight contexts (NNM).
 *
 * Two input modes:
 *   - text mode (default): free-text input, Enter submits via onSubmit.
 *   - chipMode            : input holds raw nostr:npub text; Enter OR comma
 *                           parses the input, converts each parsed npub into
 *                           a `.mention-link--bg` chip rendered below the input,
 *                           and clears the input. The chip list is the source
 *                           of truth — onSubmit's `value` argument is the
 *                           remaining (usually empty) text. Use onChipsChange
 *                           to keep the caller's state in sync.
 *
 * The submit behaviour is fully owned by the caller via `onSubmit`, which
 * receives the current input value plus helpers (`showStatus`, `hideStatus`,
 * `setButtonState`) so the caller can drive feedback without re-querying the DOM.
 */

import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { npubToHex } from '../../helpers/nip19';

export type ProfileSearchSizeVariant = 'inline-icon-row' | 'compact-modal';

export interface ProfileSearchHelpers {
  showStatus: (message: string, type: 'info' | 'error') => void;
  hideStatus: () => void;
  setButtonState: (state: 'idle' | 'loading' | 'disabled') => void;
  collapse: () => void;
}

export interface ProfileSearchChip {
  pubkey: string;
  npub: string;
  username: string;
}

export interface ProfileSearchOptions {
  /** Submit handler — receives input value and helpers. Required. */
  onSubmit: (
    value: string,
    helpers: ProfileSearchHelpers
  ) => Promise<void> | void;

  /** Trigger icon (SVG symbol id from public/icons.svg). Default: 'icon-search'. */
  triggerIconId?: string;
  /** Trigger link title (used as tooltip label). Default: 'Search in this user's timeline'. */
  triggerTitle?: string;
  /** Input placeholder. Default: 'Search terms...'. */
  placeholder?: string;
  /** Button label (idle). Default: 'Search'. */
  buttonText?: string;
  /** Button label (loading). Default: 'Searching...'. */
  buttonLoadingText?: string;
  /** Button size modifier. Default: 'btn-medium btn-passive'. */
  buttonClass?: string;
  /** Size variant — drives the SCSS modifier. Default: 'inline-icon-row'. */
  sizeVariant?: ProfileSearchSizeVariant;
  /** Small hint text rendered below the form (e.g. privacy notice). Default: none. */
  privacyHint?: string;
  /** Whether the status area exists at all. Default: true. */
  statusEnabled?: boolean;

  /**
   * Chip mode — when true, the input holds raw nostr:npub text and the
   * component parses it into `.mention-link--bg` chips on Enter or comma.
   * The chip list is the source of truth; onSubmit's value is just the
   * remaining unparsed text. Default: false.
   */
  chipMode?: boolean;
  /** Initial chips to render when the component mounts (chipMode only). */
  initialChips?: ProfileSearchChip[];
  /** Live chip updates (chipMode only) — fires on every add/remove. */
  onChipsChange?: (chips: ProfileSearchChip[]) => void;
  /**
   * Fires whenever the panel collapses (ESC, outside-click, Apply via
   * helpers.collapse, or explicit collapseSearch()). Use to clean up the
   * host in the caller.
   */
  onClose?: () => void;
}

const CHIP_NPUB_REGEX =
  /(?:nostr:)?(npub1[023456789acdefghjklmnpqrstuvwxyz]{58})/g;

export class ProfileSearchComponent {
  private container: HTMLElement;
  private options: Required<
    Omit<
      ProfileSearchOptions,
      'onSubmit' | 'privacyHint' | 'initialChips' | 'onChipsChange' | 'onClose'
    >
  > & {
    onSubmit: ProfileSearchOptions['onSubmit'];
    privacyHint: string | undefined;
    initialChips: ProfileSearchChip[] | undefined;
    onChipsChange: ProfileSearchOptions['onChipsChange'];
    onClose: ProfileSearchOptions['onClose'];
  };
  private isExpanded: boolean = false;
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
  private clickOutsideHandler: ((e: MouseEvent) => void) | null = null;
  /** Chip state (chipMode only). Source of truth for tagged users. */
  private chips: ProfileSearchChip[] = [];
  /**
   * Last-known usernames from MentionAutocomplete selections — used as a
   * cache when the same npub is later converted to a chip via Enter/comma
   * (so the chip shows the proper name instead of a truncated npub).
   */
  private knownUsernames: Map<string, string> = new Map();

  constructor(options: ProfileSearchOptions) {
    this.options = {
      onSubmit: options.onSubmit,
      triggerIconId: options.triggerIconId ?? 'icon-search',
      triggerTitle: options.triggerTitle ?? "Search in this user's timeline",
      placeholder: options.placeholder ?? 'Search terms...',
      buttonText: options.buttonText ?? 'Search',
      buttonLoadingText: options.buttonLoadingText ?? 'Searching...',
      buttonClass: options.buttonClass ?? 'btn-medium btn-passive',
      sizeVariant: options.sizeVariant ?? 'inline-icon-row',
      privacyHint: options.privacyHint,
      statusEnabled: options.statusEnabled ?? true,
      chipMode: options.chipMode ?? false,
      initialChips: options.initialChips,
      onChipsChange: options.onChipsChange,
      onClose: options.onClose,
    };
    if (this.options.chipMode && this.options.initialChips) {
      this.chips = [...this.options.initialChips];
    }
    this.container = this.createElement();
    this.setupEventListeners();
    if (this.options.chipMode) this.renderChips();
  }

  /**
   * Create search component structure
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = `textinput-overlay textinput-overlay--${this.options.sizeVariant}`;

    const statusHtml = this.options.statusEnabled
      ? '<div class="textinput-overlay__status is-hidden"></div>'
      : '';
    const privacyHintHtml = this.options.privacyHint
      ? `<div class="textinput-overlay__privacy-hint">${escapeHtml(this.options.privacyHint)}</div>`
      : '';
    const chipsHtml = this.options.chipMode
      ? '<div class="textinput-overlay__chips" data-chips></div>'
      : '';

    container.innerHTML = `
      <div class="textinput-overlay__trigger">
        <a href="#" class="textinput-overlay__link" title="${escapeHtmlAttr(this.options.triggerTitle)}">
          <svg width="18" height="18"><use href="#${escapeHtmlAttr(this.options.triggerIconId)}"/></svg>
        </a>
      </div>
      <div class="textinput-overlay__panel is-hidden">
        <div class="textinput-overlay__form">
          <input
            type="text"
            class="input textinput-overlay__input"
            placeholder="${escapeHtmlAttr(this.options.placeholder)}"
          />
          <button class="textinput-overlay__btn ${this.options.buttonClass}" type="button">
            ${escapeHtml(this.options.buttonText)}
          </button>
        </div>
        ${chipsHtml}
        ${privacyHintHtml}
        ${statusHtml}
      </div>
    `;

    return container;
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    const link = this.container.querySelector('.textinput-overlay__link');
    const input = this.container.querySelector(
      '.textinput-overlay__input'
    ) as HTMLInputElement | null;
    const button = this.container.querySelector('.textinput-overlay__btn');

    link?.addEventListener('click', e => {
      e.preventDefault();
      this.expandSearch();
    });

    // Use keydown (not keypress) so we can intercept comma reliably across
    // locales and prevent the default Enter=form-submit early.
    input?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.options.chipMode) {
          // Enter in chipMode = commit current text to chips, keep overlay open.
          this.parseInputIntoChips();
        } else {
          void this.handleSubmit();
        }
        return;
      }
      if (this.options.chipMode && e.key === ',') {
        e.preventDefault();
        this.parseInputIntoChips();
      }
    });

    button?.addEventListener('click', () => {
      if (this.options.chipMode) {
        // Flush any remaining text into chips before submitting.
        this.parseInputIntoChips();
      }
      void this.handleSubmit();
    });

    // Chip remove buttons (event delegation — chips are re-rendered often)
    const chipsArea = this.container.querySelector('[data-chips]');
    chipsArea?.addEventListener('click', e => {
      const removeBtn = (e.target as HTMLElement).closest(
        '[data-chip-remove]'
      ) as HTMLElement | null;
      if (!removeBtn) return;
      // Stop propagation BEFORE removeChip rebuilds the chips DOM. Without
      // this, the click bubbles to the document-level outside-click handler
      // AFTER the original target (the × button) has been detached from the
      // DOM — Node.contains() returns false for detached nodes, so the
      // handler mistakenly treats the click as "outside" and collapses the
      // overlay.
      e.stopPropagation();
      const pubkey = removeBtn.dataset.chipRemove;
      if (pubkey) this.removeChip(pubkey);
    });
  }

  /**
   * Chip mode: scan the input for nostr:npub / npub tokens, add each as a
   * chip (deduped), then clear the input. Called on Enter, comma, and Apply.
   */
  private parseInputIntoChips(): void {
    const input = this.container.querySelector(
      '.textinput-overlay__input'
    ) as HTMLInputElement | null;
    if (!input) return;
    const text = input.value;
    if (!text.trim()) return;

    CHIP_NPUB_REGEX.lastIndex = 0;
    const matches = Array.from(text.matchAll(CHIP_NPUB_REGEX));
    if (matches.length === 0) return;

    for (const match of matches) {
      const npub = match[1]!;
      const pubkey = npubToHex(npub);
      if (!pubkey) continue;
      if (this.chips.some(c => c.pubkey === pubkey)) continue; // dedup
      const username = this.knownUsernames.get(npub) ?? this.truncateNpub(npub);
      this.chips.push({ pubkey, npub, username });
    }

    // Clear the input — chips are the source of truth now.
    input.value = '';
    this.renderChips();
    this.notifyChipsChange();
    input.focus();
  }

  private removeChip(pubkey: string): void {
    this.chips = this.chips.filter(c => c.pubkey !== pubkey);
    this.renderChips();
    this.notifyChipsChange();
  }

  /**
   * Re-render the chips area from `this.chips`. Cheap because chip counts are
   * small (≤50) and the area is a leaf DOM node.
   */
  private renderChips(): void {
    const area = this.container.querySelector(
      '[data-chips]'
    ) as HTMLElement | null;
    if (!area) return;
    if (this.chips.length === 0) {
      area.innerHTML = '';
      area.classList.remove('is-populated');
      return;
    }
    area.classList.add('is-populated');
    area.innerHTML = this.chips
      .map(
        chip => `
      <span class="textinput-overlay__chip mention-link mention-link--bg">
        <span class="textinput-overlay__chip-name">${escapeHtml(chip.username)}</span>
        <button type="button" class="textinput-overlay__chip-remove" data-chip-remove="${escapeHtmlAttr(chip.pubkey)}" aria-label="Remove ${escapeHtmlAttr(chip.username)}">×</button>
      </span>
    `
      )
      .join('');
  }

  private notifyChipsChange(): void {
    this.options.onChipsChange?.(this.chips);
  }

  private truncateNpub(npub: string): string {
    return npub.length > 16 ? `${npub.slice(0, 12)}…` : npub;
  }

  /**
   * Called by the caller (via MentionAutocomplete.onMentionInserted) to cache
   * the username for a freshly-selected npub, so the eventual chip created
   * from Enter/comma shows the proper name instead of a truncated npub.
   */
  public registerKnownUsername(npub: string, username: string): void {
    this.knownUsernames.set(npub, username);
  }

  /**
   * Convert a just-selected MentionAutocomplete suggestion directly into a
   * chip — bypassing the raw-text phase entirely. The chip appears
   * instantly, the input is cleared so the user can type the next @mention.
   *
   * Used in chipMode callers (e.g. image-tagging). The caller wires this to
   * MentionAutocomplete's `onMentionInserted` callback. MentionAutocomplete
   * still inserts `nostr:{npub}` into the input before firing the callback —
   * this method clears that text right back out, so the user never sees it.
   */
  public addChipFromMention(npub: string, username: string): void {
    const pubkey = npubToHex(npub);
    if (!pubkey) return;
    if (this.chips.some(c => c.pubkey === pubkey)) return; // dedup
    this.knownUsernames.set(npub, username);
    this.chips.push({ pubkey, npub, username });
    // Clear the input — MentionAutocomplete already inserted `nostr:{npub} `;
    // we replace that text with the chip.
    const input = this.container.querySelector(
      '.textinput-overlay__input'
    ) as HTMLInputElement | null;
    if (input) input.value = '';
    this.renderChips();
    this.notifyChipsChange();
    input?.focus();
  }

  /**
   * Expand search overlay
   */
  public expandSearch(): void {
    if (this.isExpanded) return;

    const overlay = this.container.querySelector(
      '.textinput-overlay__panel'
    ) as HTMLElement;
    overlay.classList.remove('is-hidden');
    this.isExpanded = true;

    const input = this.container.querySelector(
      '.textinput-overlay__input'
    ) as HTMLInputElement | null;
    setTimeout(() => input?.focus(), 100);

    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.collapseSearch();
      }
    };
    document.addEventListener('keydown', this.escapeHandler);

    setTimeout(() => {
      this.clickOutsideHandler = (e: MouseEvent) => {
        const overlayEl = this.container.querySelector(
          '.textinput-overlay__panel'
        );
        if (!this.isExpanded || !overlayEl) return;
        if (overlayEl.contains(e.target as Node)) return;
        // MentionAutocomplete appends its dropdown to <body>, so a click on
        // a suggestion is technically "outside" the panel — but selecting a
        // mention must not close the overlay.
        const target = e.target as HTMLElement;
        if (target.closest('.mention-autocomplete')) return;
        this.collapseSearch();
      };
      document.addEventListener('click', this.clickOutsideHandler);
    }, 0);
  }

  /**
   * Collapse search overlay
   */
  public collapseSearch(): void {
    if (!this.isExpanded) return;

    const overlay = this.container.querySelector(
      '.textinput-overlay__panel'
    ) as HTMLElement;
    overlay.classList.add('is-hidden');
    this.isExpanded = false;

    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler);
      this.escapeHandler = null;
    }
    if (this.clickOutsideHandler) {
      document.removeEventListener('click', this.clickOutsideHandler);
      this.clickOutsideHandler = null;
    }

    // Notify caller so it can destroy the host + drop its reference. Called
    // AFTER the panel is hidden so the DOM is in a stable state.
    this.options.onClose?.();
  }

  /**
   * Drive the submit handler with helpers
   */
  private async handleSubmit(): Promise<void> {
    const input = this.container.querySelector(
      '.textinput-overlay__input'
    ) as HTMLInputElement | null;
    if (!input) return;
    const value = input.value.trim();

    // In chipMode the chip list is the source of truth; require at least
    // one chip OR raw text to submit. In text mode require non-empty text.
    if (!this.options.chipMode && !value) return;
    if (this.options.chipMode && this.chips.length === 0 && !value) return;

    const helpers: ProfileSearchHelpers = {
      showStatus: (message, type) => this.showStatus(message, type),
      hideStatus: () => this.hideStatus(),
      setButtonState: state => this.setButtonState(state),
      collapse: () => this.collapseSearch(),
    };

    try {
      await this.options.onSubmit(value, helpers);
    } catch (error) {
      console.error('[ProfileSearchComponent] onSubmit threw:', error);
      helpers.showStatus(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
      helpers.setButtonState('idle');
    }
  }

  /**
   * Set button state — idle / loading / disabled
   */
  private setButtonState(state: 'idle' | 'loading' | 'disabled'): void {
    const button = this.container.querySelector(
      '.textinput-overlay__btn'
    ) as HTMLButtonElement | null;
    if (!button) return;
    if (state === 'loading') {
      button.disabled = true;
      button.textContent = this.options.buttonLoadingText;
    } else if (state === 'disabled') {
      button.disabled = true;
    } else {
      button.disabled = false;
      button.textContent = this.options.buttonText;
    }
  }

  /**
   * Show status message
   */
  private showStatus(message: string, type: 'info' | 'error'): void {
    if (!this.options.statusEnabled) return;
    const status = this.container.querySelector(
      '.textinput-overlay__status'
    ) as HTMLElement | null;
    if (status) {
      status.textContent = message;
      status.className = `textinput-overlay__status textinput-overlay__status--${type}`;
      status.classList.remove('is-hidden');
    }
  }

  /**
   * Hide status message
   */
  private hideStatus(): void {
    if (!this.options.statusEnabled) return;
    const status = this.container.querySelector(
      '.textinput-overlay__status'
    ) as HTMLElement | null;
    if (status) {
      status.classList.add('is-hidden');
    }
  }

  /**
   * Pre-fill the input (e.g. when reopening to edit existing tags)
   */
  public setValue(value: string): void {
    const input = this.container.querySelector(
      '.textinput-overlay__input'
    ) as HTMLInputElement | null;
    if (input) input.value = value;
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
