/**
 * GIF Picker Component — search and pick GIFs from gifs.nostr.build.
 *
 * Mirrors the EmojiPicker pattern (overlay + positioned container + search)
 * with the integration guide's UX rules: debounced search (250 ms) with stale
 * request dropping, starter/suggest chips, masonry grid of w240/w480 animated
 * previews sized from API width/height (no layout shift), LQIP placeholder
 * removed on load, animation only for tiles in view, reduced-motion stills,
 * "GIFs from nostr.build" attribution link, and typed error states
 * (429 / 503 / empty). Escape and click-outside close the picker.
 */

import {
  GifSearchError,
  GifSearchService,
  type GifItem,
  type GifPreview,
} from '../../services/GifSearchService';
import { escapeHtmlAttr } from '../../helpers/escapeHtml';
import { gifFormatToMime, type GifMeta } from '../../helpers/gifImeta';

export interface GifPickerOptions {
  /** Callback when a GIF is picked (receives the ORIGINAL url + metadata). */
  onSelect: (gif: GifItem) => void;
  /** Element to position picker relative to */
  triggerElement?: HTMLElement;
}

/** Everyday starter searches shown when the field is empty (no trending API). */
const STARTER_QUERIES = [
  'gm',
  'lol',
  'yes',
  'wow',
  'applause',
  'facepalm',
  'love',
  'fire',
];

const SEARCH_DEBOUNCE_MS = 250;
/** Grid preview width bucket switch (guide: w240 under 640px, w480 from 640px). */
const NARROW_VIEWPORT_PX = 640;

export class GifPicker {
  private container: HTMLElement;
  private overlay: HTMLElement;
  private options: GifPickerOptions;
  private service: GifSearchService;

  private searchInput: HTMLInputElement | null = null;
  private chipsRow: HTMLElement | null = null;
  private gridContainer: HTMLElement | null = null;
  private statusRegion: HTMLElement | null = null;

  /** Monotonic request id — answers from older requests are dropped. */
  private searchSeq = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private suggestAbort: AbortController | null = null;
  private clickOutsideHandler: ((e: MouseEvent) => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private observer: IntersectionObserver | null = null;
  private prefersReducedMotion: boolean;

  constructor(options: GifPickerOptions) {
    this.options = options;
    this.service = GifSearchService.getInstance();
    this.prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;

    this.overlay = this.createOverlay();
    this.container = this.createElement();
    this.overlay.appendChild(this.container);
  }

  // ── DOM construction ───────────────────────────────────────────────

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'gif-picker-custom';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'gif-picker-search input';
    searchInput.placeholder = 'Search GIFs...';
    searchInput.setAttribute('aria-label', 'Search GIFs');
    searchInput.addEventListener('input', () => this.handleInput());
    this.searchInput = searchInput;

    // Chips: starters when empty, suggest terms while typing.
    const chips = document.createElement('div');
    chips.className = 'gif-picker-chips';
    this.chipsRow = chips;

    // Scrollable grid area.
    const gridContainer = document.createElement('div');
    gridContainer.className = 'gif-picker-grid-container';
    this.gridContainer = gridContainer;

    // Polite live region announcing result counts / errors.
    const status = document.createElement('div');
    status.className = 'visually-hidden';
    status.setAttribute('aria-live', 'polite');
    this.statusRegion = status;

    // Required attribution (condition of use).
    const attribution = document.createElement('div');
    attribution.className = 'gif-picker-attribution';
    attribution.innerHTML =
      'GIFs from <a href="https://nostr.build" target="_blank" rel="noopener noreferrer">nostr.build</a>';

    container.appendChild(searchInput);
    container.appendChild(chips);
    container.appendChild(gridContainer);
    container.appendChild(attribution);
    container.appendChild(status);

    return container;
  }

  private createOverlay(): HTMLElement {
    const overlay = document.createElement('div');
    overlay.className = 'gif-picker-overlay';
    overlay.style.display = 'none';
    return overlay;
  }

  // ── Show / hide / positioning (mirrors EmojiPicker) ────────────────

  public show(): void {
    if (!this.overlay.parentElement) {
      document.body.appendChild(this.overlay);
    }

    this.overlay.style.display = 'flex';

    if (this.options.triggerElement) {
      this.positionPicker(this.options.triggerElement);
    }

    // Open on the first starter chip's results (no keyboard pop on phones).
    void this.runSearch(STARTER_QUERIES[0]!, { isStarter: true });

    setTimeout(() => {
      this.clickOutsideHandler = (e: MouseEvent) => {
        if (!this.container.contains(e.target as Node)) {
          this.hide();
        }
      };
      document.addEventListener('click', this.clickOutsideHandler);
      this.keyHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          this.hide();
        }
      };
      document.addEventListener('keydown', this.keyHandler);
    }, 0);
  }

  public hide(): void {
    this.overlay.style.display = 'none';
    this.teardownListeners();
  }

  private positionPicker(trigger: HTMLElement): void {
    const rect = trigger.getBoundingClientRect();
    const pickerHeight = 480;
    const pickerWidth = 360;
    const margin = 10;

    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;

    if (spaceAbove >= pickerHeight || spaceAbove > spaceBelow) {
      this.container.style.bottom = `${window.innerHeight - rect.top + 10}px`;
      this.container.style.top = 'auto';
    } else {
      this.container.style.top = `${rect.bottom + 10}px`;
      this.container.style.bottom = 'auto';
    }

    if (rect.left + pickerWidth > window.innerWidth - margin) {
      this.container.style.right = `${window.innerWidth - rect.right}px`;
      this.container.style.left = 'auto';
    } else {
      this.container.style.left = `${rect.left}px`;
      this.container.style.right = 'auto';
    }
  }

  public destroy(): void {
    this.hide();
    this.overlay.remove();
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  private teardownListeners(): void {
    if (this.clickOutsideHandler) {
      document.removeEventListener('click', this.clickOutsideHandler);
      this.clickOutsideHandler = null;
    }
    if (this.keyHandler) {
      document.removeEventListener('keydown', this.keyHandler);
      this.keyHandler = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.searchSeq++; // invalidate in-flight answers
    this.abortController?.abort();
    this.abortController = null;
    this.suggestAbort?.abort();
    this.suggestAbort = null;
    this.observer?.disconnect();
    this.observer = null;
  }

  // ── Search flow ────────────────────────────────────────────────────

  private handleInput(): void {
    const query = this.searchInput?.value ?? '';
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.runSearch(query);
    }, SEARCH_DEBOUNCE_MS);
  }

  private async runSearch(
    rawQuery: string,
    opts: { isStarter?: boolean } = {}
  ): Promise<void> {
    const query = rawQuery.trim();
    const seq = ++this.searchSeq;

    // Cancel the previous request — the guide's rule for stale requests.
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;

    this.observer?.disconnect();
    this.renderSkeleton(query);

    try {
      const result = await this.service.search(query, controller.signal);
      if (seq !== this.searchSeq) return;

      this.renderGrid(query, result.items);
      this.announce(
        result.items.length > 0
          ? `${result.items.length} GIFs for ${result.q}`
          : `No GIFs for ${result.q}`
      );

      // Suggest chips only while the user is typing (not for starters).
      if (!opts.isStarter) void this.loadSuggestions(query, seq);
      else this.renderStarters();
    } catch (error) {
      if (seq !== this.searchSeq) return;
      if (error instanceof GifSearchError && error.code === 'network') {
        return; // aborted — a newer search took over
      }
      this.renderError(query, error);
      this.renderStarters();
    }
  }

  private async loadSuggestions(query: string, seq: number): Promise<void> {
    this.suggestAbort?.abort();
    const controller = new AbortController();
    this.suggestAbort = controller;
    try {
      const terms = await this.service.suggest(query, controller.signal);
      if (seq !== this.searchSeq) return;
      this.renderSuggestChips(query, terms);
    } catch {
      // Chips are optional — leave whatever is rendered.
    }
  }

  // ── Chips ──────────────────────────────────────────────────────────

  private createChip(label: string): HTMLButtonElement {
    const chip = document.createElement('button');
    chip.className = 'gif-picker-chip';
    chip.textContent = label;
    chip.addEventListener('click', () => {
      if (this.searchInput) this.searchInput.value = label;
      void this.runSearch(label);
    });
    return chip;
  }

  private renderStarters(): void {
    if (!this.chipsRow) return;
    this.chipsRow.innerHTML = '';
    for (const q of STARTER_QUERIES) {
      this.chipsRow.appendChild(this.createChip(q));
    }
  }

  private renderSuggestChips(query: string, terms: string[]): void {
    if (!this.chipsRow) return;
    const filtered = terms.filter(
      t => t.toLowerCase() !== query.trim().toLowerCase()
    );
    this.chipsRow.innerHTML = '';
    for (const term of filtered) {
      this.chipsRow.appendChild(this.createChip(term));
    }
  }

  // ── Grid rendering ─────────────────────────────────────────────────

  private renderSkeleton(query: string): void {
    if (!this.gridContainer) return;
    this.gridContainer.innerHTML = '';
    const status = document.createElement('div');
    status.className = 'gif-picker-state';
    status.innerHTML = `<p class="pulsate">${query ? `Searching “${escapeHtmlAttr(query)}”...` : 'Loading GIFs...'}</p>`;
    this.gridContainer.appendChild(status);
  }

  private renderGrid(query: string, items: GifItem[]): void {
    if (!this.gridContainer) return;
    this.gridContainer.innerHTML = '';

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'gif-picker-state';
      empty.innerHTML = `<p>No GIFs for “${escapeHtmlAttr(query)}”</p>`;
      this.gridContainer.appendChild(empty);
      this.renderStarters();
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'gif-picker-grid';
    for (const item of items) {
      grid.appendChild(this.createTile(item));
    }
    this.gridContainer.appendChild(grid);

    // Animate only tiles in or near the viewport. Tiles START on their still
    // frame; the observer upgrades them to the animated preview when they
    // enter the viewport (and downgrades again when they leave).
    this.observer?.disconnect();
    this.observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          const img = entry.target as HTMLImageElement;
          const still = img.dataset.still;
          const animated = img.dataset.animated;
          if (!still) continue;
          const nextSrc =
            !this.prefersReducedMotion && entry.isIntersecting && animated
              ? animated
              : still;
          if (img.src !== nextSrc && !img.dataset.errored) {
            img.src = nextSrc;
          }
        }
      },
      { rootMargin: '200px' }
    );

    const useNarrow = window.innerWidth < NARROW_VIEWPORT_PX;
    void useNarrow; // preview bucket is chosen per-tile in pickPreview()
    for (const tile of Array.from(grid.children)) {
      const img = tile.querySelector('img');
      if (img) this.observer.observe(img);
    }
  }

  /**
   * Create one tile. Layout comes from the API width/height BEFORE anything
   * loads (aspect-ratio, clamped to 0.75–2 so no sliver/tower tiles); the LQIP
   * blurred placeholder paints behind and is removed on load.
   */
  private createTile(item: GifItem): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'gif-picker-tile';
    button.title = item.title || 'GIF';
    button.setAttribute('aria-label', item.title || 'GIF');

    const ratio = Math.min(
      2,
      Math.max(0.75, item.width / Math.max(item.height, 1))
    );
    button.style.aspectRatio = String(ratio);

    if (item.lqip && item.lqip.startsWith('data:image/')) {
      button.style.backgroundImage = `url("${item.lqip}")`;
      button.style.backgroundSize = 'cover';
      button.style.backgroundPosition = 'center';
    }

    const preview = this.pickPreview(item);
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = item.title || 'GIF';
    img.dataset.still = preview.still;
    if (preview.animated) img.dataset.animated = preview.animated;
    img.addEventListener('load', () => {
      // Remove the blur placeholder — many GIFs are transparent.
      button.style.backgroundImage = '';
      img.classList.add('gif-picker-tile-img--loaded');
    });
    img.addEventListener('error', () => {
      // Animated preview failed (or null) → fall back to the still frame.
      if (img.src !== img.dataset.still && img.dataset.still) {
        img.src = img.dataset.still;
      } else {
        img.dataset.errored = '1';
      }
    });
    // Start on the still frame — the IntersectionObserver upgrades tiles that
    // enter the viewport to the animated preview (reduced motion: never).
    img.src = preview.still;

    button.appendChild(img);
    button.addEventListener('click', () => this.handlePick(item));
    return button;
  }

  /** w240 under 640px viewport, w480 from 640px (guide rule). */
  private pickPreview(item: GifItem): GifPreview {
    const narrow = window.innerWidth < NARROW_VIEWPORT_PX;
    const preview =
      (narrow ? item.previews.w240 : item.previews.w480) ??
      item.previews.w240 ??
      item.previews.w480 ??
      item.previews.medium;
    return (
      preview ?? {
        width: item.width,
        height: item.height,
        animated: null,
        still: item.url,
      }
    );
  }

  // ── Pick ───────────────────────────────────────────────────────────

  private handlePick(item: GifItem): void {
    // Persist metadata for the publish-time imeta tag (PostService reads it).
    const meta: GifMeta & { url: string } = {
      url: item.url,
      m: gifFormatToMime(item.format),
      dim: `${item.width}x${item.height}`,
      size: item.bytes,
    };
    if (item.title) meta.alt = item.title;
    this.service.rememberGif(meta);

    this.options.onSelect(item);
    this.hide(); // one pick per opening — stale double taps hit a hidden picker
  }

  // ── States ─────────────────────────────────────────────────────────

  private renderError(query: string, error: unknown): void {
    if (!this.gridContainer) return;
    this.gridContainer.innerHTML = '';

    let message = 'Search is unavailable right now.';
    let showRetry = true;

    if (error instanceof GifSearchError) {
      if (error.code === 'rate_limited') {
        message = 'Too many searches — wait a minute.';
        showRetry = false;
      } else if (error.code === 'validation') {
        message = 'Enter a search term.';
        showRetry = false;
      }
    }

    const state = document.createElement('div');
    state.className = 'gif-picker-state';
    const p = document.createElement('p');
    p.textContent = message;
    state.appendChild(p);

    if (showRetry) {
      const retry = document.createElement('button');
      retry.className = 'btn btn--passive btn--mini';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => {
        void this.runSearch(this.searchInput?.value || STARTER_QUERIES[0]!);
      });
      state.appendChild(retry);
    }

    this.gridContainer.appendChild(state);
    this.announce(`GIF search failed for ${query}: ${message}`);
  }

  private announce(message: string): void {
    if (this.statusRegion) this.statusRegion.textContent = message;
  }
}
