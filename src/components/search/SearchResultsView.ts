/**
 * SearchResultsView - Generic search results component
 * Modular, reusable component for displaying search results from any source
 * Used by: Profile Search, Global Search, Hashtag Search
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { formatTimestamp } from '../../helpers/formatTimestamp';
import { escapeHtml } from '../../helpers/escapeHtml';
import { InfiniteScroll } from '../ui/InfiniteScroll';
import { HashtagNotificationService } from '../../services/HashtagNotificationService';
import { EventBus } from '../../services/EventBus';

export interface SearchResultsConfig {
  title: string;
  searchTerms: string;
  meta?: string; // Optional meta info (e.g., "44 matches found")
  showBackLink?: boolean;
  onBackClick?: () => void;
  hashtag?: string; // For hashtag search subscribe button
}

export interface SearchResultsCallbacks {
  onNoteClick: (noteId: string) => void;
  onLoadMore?: () => Promise<void>;
}

export class SearchResultsView {
  private container: HTMLElement;
  private config: SearchResultsConfig;
  private callbacks: SearchResultsCallbacks;
  private infiniteScroll?: InfiniteScroll;
  private listElement?: HTMLElement;
  private hashtagService: HashtagNotificationService;
  private eventBus: EventBus;
  private subscribeButton?: HTMLButtonElement;
  private subscriptionUpdatedId?: string;

  constructor(config: SearchResultsConfig, callbacks: SearchResultsCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
    this.hashtagService = HashtagNotificationService.getInstance();
    this.eventBus = EventBus.getInstance();
    this.container = this.createElement();
    this.setupEventListeners();
  }

  /**
   * Create results container
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'search-results';
    return container;
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Listen for subscription updates to update button state
    this.subscriptionUpdatedId = this.eventBus.on('hashtag-subscription:updated', (data: { hashtag: string; subscribed: boolean }) => {
      if (data.hashtag === this.config.hashtag) {
        this.updateSubscribeButton();
      }
    });
  }

  /**
   * Render search results
   */
  public render(results: NostrEvent[]): void {
    // Clear container
    this.container.innerHTML = '';

    // Back link (if enabled)
    if (this.config.showBackLink && this.config.onBackClick) {
      const backLink = document.createElement('div');
      backLink.className = 'search-results__back';
      backLink.innerHTML = `
        <a href="#" class="search-results__back-link">← Back to Search Results</a>
      `;
      backLink.querySelector('a')?.addEventListener('click', (e) => {
        e.preventDefault();
        this.config.onBackClick!();
      });
      this.container.appendChild(backLink);
    }

    // Results header
    const header = document.createElement('div');
    header.className = 'search-results__header';

    // Title
    const title = document.createElement('h3');
    title.textContent = this.config.title;
    header.appendChild(title);

    // Row with meta (left) and subscribe button (right)
    const headerRow = document.createElement('div');
    headerRow.className = 'search-results__header-row';

    if (this.config.meta) {
      const meta = document.createElement('span');
      meta.className = 'search-results__meta';
      meta.textContent = this.config.meta;
      headerRow.appendChild(meta);
    }

    // Add subscribe button if hashtag is provided
    if (this.config.hashtag) {
      this.subscribeButton = document.createElement('button');
      this.subscribeButton.className = 'btn btn--medium';
      this.updateSubscribeButton();

      this.subscribeButton.addEventListener('click', () => {
        if (this.config.hashtag) {
          this.hashtagService.toggle(this.config.hashtag);
          this.updateSubscribeButton();
        }
      });

      headerRow.appendChild(this.subscribeButton);
    }

    header.appendChild(headerRow);
    this.container.appendChild(header);

    // Results list
    if (results.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'search-results__empty';
      empty.textContent = 'No matching notes found.';
      this.container.appendChild(empty);
    } else {
      this.listElement = document.createElement('div');
      this.listElement.className = 'search-results__list';

      results.forEach(note => {
        const item = this.createResultItem(note, this.config.searchTerms);
        this.listElement!.appendChild(item);
      });

      this.container.appendChild(this.listElement);

      // Setup InfiniteScroll if callback provided
      if (this.callbacks.onLoadMore) {
        this.infiniteScroll = new InfiniteScroll(this.callbacks.onLoadMore, {
          loadingMessage: 'Fetching more results from Relays...'
        });
        this.infiniteScroll.observe(this.listElement);
      }
    }
  }

  /**
   * Update subscribe button text and state
   */
  private updateSubscribeButton(): void {
    if (!this.subscribeButton || !this.config.hashtag) return;

    const isSubscribed = this.hashtagService.isSubscribed(this.config.hashtag);
    this.subscribeButton.textContent = isSubscribed
      ? `Unsubscribe from #${this.config.hashtag}`
      : `Subscribe to #${this.config.hashtag}`;
  }

  /**
   * Show loading indicator
   */
  public showLoading(): void {
    this.infiniteScroll?.showLoading();
  }

  /**
   * Hide loading indicator
   */
  public hideLoading(): void {
    this.infiniteScroll?.hideLoading();
  }

  /**
   * Append more results (for InfiniteScroll)
   */
  public appendResults(newResults: NostrEvent[]): void {
    if (!this.listElement) return;

    newResults.forEach(note => {
      const item = this.createResultItem(note, this.config.searchTerms);
      this.listElement!.appendChild(item);
    });

    // Refresh InfiniteScroll sentinel position
    this.infiniteScroll?.refresh();
  }

  /**
   * Create single result item
   */
  private createResultItem(note: NostrEvent, searchTerms: string): HTMLElement {
    const item = document.createElement('div');
    item.className = 'ui-list__item ui-list__item--clickable search-results__item';
    item.dataset.noteId = note.id;

    const date = formatTimestamp(note.created_at);
    const excerpt = this.createExcerpt(note.content, searchTerms);

    item.innerHTML = `
      <span class="search-results__date">${date}</span>
      <div class="search-results__excerpt">${excerpt}</div>
    `;

    // Make entire item clickable
    const noteId = note.id;
    if (noteId) {
      item.addEventListener('click', () => {
        this.callbacks.onNoteClick(noteId);
      });
    }

    return item;
  }

  /**
   * Create excerpt with search term highlighting
   */
  private createExcerpt(content: string, searchTerms: string): string {
    const maxLength = 200;
    const terms = searchTerms.toLowerCase().split(/\s+/);

    // Escape HTML first
    let excerpt = escapeHtml(content.substring(0, maxLength));
    if (content.length > maxLength) {
      excerpt += '...';
    }

    // Highlight search terms (case-insensitive)
    terms.forEach(term => {
      if (term.length > 0) {
        const regex = new RegExp(`(${this.escapeRegex(term)})`, 'gi');
        excerpt = excerpt.replace(regex, '<mark>$1</mark>');
      }
    });

    return excerpt;
  }

  /**
   * Escape regex special characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Update config (e.g., for changing title/meta)
   */
  public updateConfig(config: Partial<SearchResultsConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Update meta text in the header
   */
  public updateMeta(meta: string): void {
    this.config.meta = meta;
    const metaElement = this.container.querySelector('.search-results__meta');
    if (metaElement) {
      metaElement.textContent = meta;
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
    if (this.subscriptionUpdatedId) {
      this.eventBus.off(this.subscriptionUpdatedId);
    }
    this.infiniteScroll?.destroy();
    this.container.remove();
  }
}
