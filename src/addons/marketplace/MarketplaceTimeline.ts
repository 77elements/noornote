/**
 * MarketplaceTimeline Component
 * Displays a grid of NIP-99 classified listings (kind:30402)
 *
 * Part of the Marketplace Add-On — only loaded when feature is enabled.
 * Cloned from ArticleTimeline, adapted for marketplace grid layout.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { MarketplaceFeedOrchestrator } from './MarketplaceFeedOrchestrator';
import { parseListingMetadata, formatPrice } from './marketplace-helpers';
import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { InfiniteScroll } from '../../components/ui/InfiniteScroll';
import { encodeNaddr } from '../../services/NostrToolsAdapter';
import { hexToNpub } from '../../helpers/nip19';
import { formatTimestamp } from '../../helpers/formatTimestamp';
import { setupUserMentionHandlers } from '../../helpers/UserMentionHelper';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';

export class MarketplaceTimeline {
  private element: HTMLElement;
  private feedOrchestrator: MarketplaceFeedOrchestrator;
  private userProfileService: UserProfileService;
  private router: Router;
  private infiniteScroll: InfiniteScroll;
  private listingsContainer: HTMLElement;
  private filterBar: HTMLElement;
  private isLoading: boolean = false;
  private hasMore: boolean = true;

  /** All fetched listings (unfiltered) */
  private allListings: NostrEvent[] = [];
  /** Tags seen across all listings, with occurrence count */
  private tagCounts: Map<string, number> = new Map();
  /** Currently active tag filter (null = show all) */
  private activeTag: string | null = null;
  /** Tags that cause a listing to be hidden entirely */
  private static readonly HIDDEN_TAGS = new Set(['gamemod']);

  constructor() {
    this.feedOrchestrator = MarketplaceFeedOrchestrator.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.router = Router.getInstance();
    this.element = this.createElement();
    this.listingsContainer = this.element.querySelector('.marketplace-timeline__grid') as HTMLElement;
    this.filterBar = this.element.querySelector('.marketplace-timeline__filters') as HTMLElement;

    this.infiniteScroll = new InfiniteScroll(
      () => this.handleLoadMore(),
      { loadingMessage: 'Loading more listings...' }
    );

    this.initialize();
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'marketplace-timeline';
    container.innerHTML = `
      <div class="marketplace-timeline__filters"></div>
      <div class="marketplace-timeline__grid"></div>
    `;
    return container;
  }

  private async initialize(): Promise<void> {
    this.showLoading();

    try {
      const result = await this.feedOrchestrator.loadInitial();
      this.hasMore = result.hasMore;

      const filtered = this.filterHiddenListings(result.listings);
      if (filtered.length > 0) {
        this.allListings = filtered;
        this.collectTags(filtered);
        this.renderFilterBar();
        this.renderListings(filtered);
        this.infiniteScroll.observe(this.listingsContainer);
      } else {
        this.showEmpty();
      }
    } catch {
      this.showError();
    }
  }

  private async handleLoadMore(): Promise<void> {
    if (this.isLoading || !this.hasMore) {
      this.infiniteScroll.disconnect();
      return;
    }

    this.isLoading = true;
    this.infiniteScroll.showLoading();

    try {
      const result = await this.feedOrchestrator.loadMore();
      this.hasMore = result.hasMore;

      const filtered = this.filterHiddenListings(result.listings);
      if (filtered.length > 0) {
        this.allListings.push(...filtered);
        this.collectTags(filtered);
        this.renderFilterBar();
        this.appendListings(filtered);

        // Apply active filter to newly appended cards
        if (this.activeTag) {
          this.setActiveTag(this.activeTag);
        }
      }

      if (!this.hasMore) {
        this.infiniteScroll.disconnect();
      } else {
        this.infiniteScroll.hideLoading();
      }
    } catch {
      this.infiniteScroll.hideLoading();
    } finally {
      this.isLoading = false;
    }
  }

  // ─── Tag Filter ──────────────────────────────────────────────────

  private filterHiddenListings(listings: NostrEvent[]): NostrEvent[] {
    return listings.filter(event => {
      const meta = parseListingMetadata(event);
      return !meta.tags.some(t => MarketplaceTimeline.HIDDEN_TAGS.has(t.toLowerCase()));
    });
  }

  private collectTags(listings: NostrEvent[]): void {
    for (const event of listings) {
      const meta = parseListingMetadata(event);
      for (const tag of meta.tags) {
        const lower = tag.toLowerCase();
        if (MarketplaceTimeline.HIDDEN_TAGS.has(lower)) continue;
        this.tagCounts.set(lower, (this.tagCounts.get(lower) || 0) + 1);
      }
    }
  }

  private renderFilterBar(): void {
    if (this.tagCounts.size === 0) {
      this.filterBar.innerHTML = '';
      return;
    }

    // Show top tags sorted by frequency, max 12
    const sorted = [...this.tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);

    this.filterBar.innerHTML = `
      <button class="marketplace-filter__chip ${!this.activeTag ? 'marketplace-filter__chip--active' : ''}" data-filter-tag="">All</button>
      ${sorted.map(([tag, count]) => `
        <button class="marketplace-filter__chip ${this.activeTag === tag ? 'marketplace-filter__chip--active' : ''}" data-filter-tag="${escapeHtmlAttr(tag)}">#${escapeHtml(tag)} <span class="marketplace-filter__count">${count}</span></button>
      `).join('')}
    `;

    this.filterBar.querySelectorAll('.marketplace-filter__chip').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tag = (e.currentTarget as HTMLElement).dataset.filterTag || '';
        this.setActiveTag(tag || null);
      });
    });
  }

  private setActiveTag(tag: string | null): void {
    this.activeTag = tag;
    this.renderFilterBar();

    // Show/hide cards via CSS instead of re-rendering
    const cards = this.listingsContainer.querySelectorAll('.listing-card');
    cards.forEach(card => {
      const cardEl = card as HTMLElement;
      if (!tag) {
        cardEl.style.display = '';
      } else {
        const cardTags = cardEl.dataset.tags || '';
        cardEl.style.display = cardTags.includes(tag) ? '' : 'none';
      }
    });

    if (!tag) {
      this.infiniteScroll.observe(this.listingsContainer);
    }
  }

  // ─── Rendering ───────────────────────────────────────────────────

  private renderListings(listings: NostrEvent[]): void {
    this.listingsContainer.innerHTML = '';
    listings.forEach(listing => {
      this.listingsContainer.appendChild(this.createListingCard(listing));
    });
  }

  private appendListings(listings: NostrEvent[]): void {
    const sentinel = this.listingsContainer.querySelector('.infinite-scroll-sentinel');
    listings.forEach(listing => {
      const card = this.createListingCard(listing);
      if (sentinel) {
        this.listingsContainer.insertBefore(card, sentinel);
      } else {
        this.listingsContainer.appendChild(card);
      }
    });
  }

  private createListingCard(event: NostrEvent): HTMLElement {
    const meta = parseListingMetadata(event);
    const card = document.createElement('article');
    card.className = 'listing-card';

    if (meta.status === 'sold') {
      card.classList.add('listing-card--sold');
    }

    // Store tags for client-side filtering (no re-render needed)
    card.dataset.tags = meta.tags.map(t => t.toLowerCase()).join(',');

    const naddr = encodeNaddr({
      kind: 30402,
      pubkey: event.pubkey,
      identifier: meta.identifier,
      relays: []
    });

    const priceDisplay = formatPrice(meta.price, meta.priceCurrency, meta.priceFrequency);
    const firstImage = meta.images[0] || '';

    card.innerHTML = `
      ${firstImage ? `
        <div class="listing-card__image">
          <img src="${escapeHtmlAttr(firstImage)}" alt="" loading="lazy" />
          ${meta.status === 'sold' ? '<span class="listing-card__sold-badge">Sold</span>' : ''}
        </div>
      ` : `
        <div class="listing-card__image listing-card__image--empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <circle cx="8.5" cy="8.5" r="1.5"></circle>
            <polyline points="21 15 16 10 5 21"></polyline>
          </svg>
          ${meta.status === 'sold' ? '<span class="listing-card__sold-badge">Sold</span>' : ''}
        </div>
      `}
      <div class="listing-card__content">
        <h3 class="listing-card__title">${escapeHtml(meta.title)}</h3>
        <div class="listing-card__price">${escapeHtml(priceDisplay)}</div>
        ${meta.location ? `<div class="listing-card__location">${escapeHtml(meta.location)}</div>` : ''}
        <div class="listing-card__meta">
          <span class="listing-card__author user-mention" data-pubkey="${event.pubkey}">
            <a href="#" class="mention-link" data-profile-pubkey="${event.pubkey}">Loading...</a>
          </span>
          <span class="listing-card__date">${formatTimestamp(meta.publishedAt)}</span>
        </div>
        ${meta.tags.length > 0 ? `
          <div class="listing-card__tags">
            ${meta.tags.slice(0, 3).map(tag => `<span class="listing-card__tag">#${escapeHtml(tag)}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `;

    // Hide card if image fails to load
    const img = card.querySelector('.listing-card__image img') as HTMLImageElement | null;
    if (img) {
      img.addEventListener('error', () => card.remove());
    }

    card.style.cursor = 'pointer';
    card.addEventListener('click', () => {
      this.router.navigate(`/listing/${naddr}`);
    });

    this.loadAuthorName(card, event.pubkey);

    return card;
  }

  private async loadAuthorName(card: HTMLElement, pubkey: string): Promise<void> {
    const authorEl = card.querySelector('.listing-card__author');
    if (!authorEl) return;

    const npub = hexToNpub(pubkey) || pubkey;

    try {
      const profile = await this.userProfileService.getUserProfile(pubkey);
      const username = profile?.name || profile?.display_name || npub.slice(0, 12) + '...';
      const picture = profile?.picture || '';

      authorEl.innerHTML = `
        <a href="/profile/${npub}" class="mention-link" data-profile-pubkey="${pubkey}">
          <img class="profile-pic profile-pic--mini" src="${escapeHtmlAttr(picture)}" alt="" />${escapeHtml(username)}</a>
      `;
    } catch {
      authorEl.innerHTML = `
        <a href="/profile/${npub}" class="mention-link" data-profile-pubkey="${pubkey}">
          ${npub.slice(0, 12)}...</a>
      `;
    }

    setupUserMentionHandlers(card);
  }

  private showLoading(): void {
    this.listingsContainer.innerHTML = `
      <div class="marketplace-timeline__loading">
        ${Array.from({ length: 6 }, () => `
          <div class="listing-card-skeleton">
            <div class="skeleton-image"></div>
            <div class="skeleton-content">
              <div class="skeleton-line skeleton-title"></div>
              <div class="skeleton-line skeleton-price"></div>
              <div class="skeleton-line skeleton-meta"></div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  private showEmpty(): void {
    this.listingsContainer.innerHTML = `
      <div class="marketplace-timeline__empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
          <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
          <line x1="3" y1="6" x2="21" y2="6"></line>
          <path d="M16 10a4 4 0 0 1-8 0"></path>
        </svg>
        <p>No listings found</p>
        <span>Marketplace listings will appear here</span>
      </div>
    `;
  }

  private showError(): void {
    this.listingsContainer.innerHTML = `
      <div class="marketplace-timeline__error">
        <p>Failed to load listings</p>
        <button class="btn btn--passive" data-action="retry">Retry</button>
      </div>
    `;

    const retryBtn = this.listingsContainer.querySelector('[data-action="retry"]');
    retryBtn?.addEventListener('click', () => this.initialize());
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    this.infiniteScroll.disconnect();
    this.element.innerHTML = '';
  }
}
