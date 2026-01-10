/**
 * ProfileArticlesCarousel Component
 * Displays a user's long-form articles (NIP-23, kind:30023) in a horizontal carousel
 * with manual left/right navigation controls.
 *
 * @component ProfileArticlesCarousel
 * @used-by ProfileView
 */

import { NostrTransport } from '../../services/transport/NostrTransport';
import { LongFormOrchestrator, type ArticleMetadata } from '../../services/orchestration/LongFormOrchestrator';
import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { encodeNaddr } from '../../services/NostrToolsAdapter';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

interface ArticleCardData {
  event: NostrEvent;
  metadata: ArticleMetadata;
  naddr: string;
}

export class ProfileArticlesCarousel {
  private element: HTMLElement;
  private pubkey: string;
  private articles: ArticleCardData[] = [];
  private transport: NostrTransport;
  private userProfileService: UserProfileService;

  constructor(pubkey: string) {
    this.pubkey = pubkey;
    this.transport = NostrTransport.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.element = document.createElement('div');
    this.element.className = 'profile-articles-carousel';
  }

  /**
   * Fetch articles and render the carousel
   * Returns the element (empty if no articles)
   */
  public async render(): Promise<HTMLElement> {
    await this.fetchArticles();

    if (this.articles.length === 0) {
      // Hide carousel if no articles
      this.element.style.display = 'none';
      return this.element;
    }

    // Fetch author name before rendering
    await this.fetchAuthorName();

    this.renderCarousel();
    this.setupEventListeners();

    return this.element;
  }

  /**
   * Fetch kind:30023 articles for this pubkey
   */
  private async fetchArticles(): Promise<void> {
    const relays = this.transport.getReadRelays();

    try {
      const events = await this.transport.fetch(relays, [{
        kinds: [30023],
        authors: [this.pubkey],
        limit: 20
      }], 8000);

      // Sort by published_at DESC (newest first)
      events.sort((a, b) => {
        const aPublished = parseInt(a.tags.find(t => t[0] === 'published_at')?.[1] || String(a.created_at));
        const bPublished = parseInt(b.tags.find(t => t[0] === 'published_at')?.[1] || String(b.created_at));
        return bPublished - aPublished;
      });

      // Extract metadata and create naddr for each article
      this.articles = events.map(event => {
        const metadata = LongFormOrchestrator.extractArticleMetadata(event);
        const naddr = encodeNaddr({
          kind: 30023,
          pubkey: event.pubkey,
          identifier: metadata.identifier,
          relays: relays.slice(0, 2) // Include up to 2 relay hints
        });

        return { event, metadata, naddr };
      });
    } catch (error) {
      console.error('[ProfileArticlesCarousel] Failed to fetch articles:', error);
      this.articles = [];
    }
  }

  /**
   * Render the carousel HTML
   */
  private renderCarousel(): void {
    const showNav = this.articles.length > 1;

    this.element.innerHTML = `
      <div class="profile-articles-carousel__header">
        <h2 class="profile-articles-carousel__title">Articles</h2>
        ${showNav ? `
          <div class="profile-articles-carousel__nav">
            <button class="profile-articles-carousel__nav-btn profile-articles-carousel__nav-btn--prev" aria-label="Previous article">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="15 18 9 12 15 6"></polyline>
              </svg>
            </button>
            <button class="profile-articles-carousel__nav-btn profile-articles-carousel__nav-btn--next" aria-label="Next article">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </button>
          </div>
        ` : ''}
      </div>
      <div class="profile-articles-carousel__viewport">
        <div class="profile-articles-carousel__track">
          ${this.articles.map(article => this.renderArticleCard(article)).join('')}
        </div>
      </div>
    `;

    // Defer nav button update until after layout
    requestAnimationFrame(() => {
      this.updateNavButtons();
    });
  }

  /**
   * Render a single article card
   */
  private renderArticleCard(article: ArticleCardData): string {
    const { metadata, naddr } = article;

    // Format date
    const date = new Date(metadata.publishedAt * 1000);
    const formattedDate = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });

    // Get author name (async, but we'll use placeholder for now)
    const authorName = this.getAuthorDisplayName();

    // Extract first ~100 chars of content as excerpt
    const excerpt = this.extractExcerpt(article.event.content, 100);

    // Image or placeholder
    const imageHtml = metadata.image
      ? `<div class="profile-articles-carousel__card-image" style="background-image: url('${this.escapeHtml(metadata.image)}')"></div>`
      : `<div class="profile-articles-carousel__card-image profile-articles-carousel__card-image--placeholder"></div>`;

    return `
      <article class="profile-articles-carousel__card" data-naddr="${this.escapeHtml(naddr)}">
        ${imageHtml}
        <div class="profile-articles-carousel__card-content">
          <h3 class="profile-articles-carousel__card-title">${this.escapeHtml(metadata.title)}</h3>
          <div class="profile-articles-carousel__card-meta">
            <span class="profile-articles-carousel__card-author">${this.escapeHtml(authorName)}</span>
            <span class="profile-articles-carousel__card-separator">·</span>
            <span class="profile-articles-carousel__card-date">${formattedDate}</span>
          </div>
          <p class="profile-articles-carousel__card-excerpt">${this.escapeHtml(excerpt)}</p>
        </div>
      </article>
    `;
  }

  /**
   * Get author display name (async fetch, cached after first call)
   */
  private authorName: string = '';

  private async fetchAuthorName(): Promise<void> {
    if (this.authorName) return;
    try {
      const profile = await this.userProfileService.getUserProfile(this.pubkey);
      this.authorName = profile.display_name || profile.name || 'Anonymous';
    } catch {
      this.authorName = 'Anonymous';
    }
  }

  private getAuthorDisplayName(): string {
    return this.authorName || 'Anonymous';
  }

  /**
   * Extract excerpt from markdown content
   */
  private extractExcerpt(content: string, maxLength: number): string {
    // Remove markdown formatting
    let text = content
      .replace(/^#+\s+/gm, '') // Remove headers
      .replace(/\*\*([^*]+)\*\*/g, '$1') // Remove bold
      .replace(/\*([^*]+)\*/g, '$1') // Remove italic
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove links
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '') // Remove images
      .replace(/`[^`]+`/g, '') // Remove inline code
      .replace(/```[\s\S]*?```/g, '') // Remove code blocks
      .replace(/\n+/g, ' ') // Replace newlines with spaces
      .trim();

    if (text.length > maxLength) {
      text = text.substring(0, maxLength).trim() + '...';
    }

    return text;
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Card click → navigate to article
    const cards = this.element.querySelectorAll('.profile-articles-carousel__card');
    cards.forEach(card => {
      card.addEventListener('click', () => {
        const naddr = (card as HTMLElement).dataset.naddr;
        if (naddr) {
          Router.getInstance().navigate(`/article/${naddr}`);
        }
      });
    });

    // Nav buttons
    const prevBtn = this.element.querySelector('.profile-articles-carousel__nav-btn--prev');
    const nextBtn = this.element.querySelector('.profile-articles-carousel__nav-btn--next');

    prevBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.scrollPrev();
    });

    nextBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.scrollNext();
    });

    // Update nav buttons on scroll
    const viewport = this.element.querySelector('.profile-articles-carousel__viewport');
    viewport?.addEventListener('scroll', () => {
      this.updateNavButtons();
    });
  }

  /**
   * Scroll to previous article
   */
  private scrollPrev(): void {
    const viewport = this.element.querySelector('.profile-articles-carousel__viewport') as HTMLElement;
    const card = this.element.querySelector('.profile-articles-carousel__card') as HTMLElement;
    if (!viewport || !card) return;

    const cardWidth = card.offsetWidth;
    const gap = 16; // $gap = 1rem = 16px
    const scrollAmount = cardWidth + gap;

    viewport.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
  }

  /**
   * Scroll to next article
   */
  private scrollNext(): void {
    const viewport = this.element.querySelector('.profile-articles-carousel__viewport') as HTMLElement;
    const card = this.element.querySelector('.profile-articles-carousel__card') as HTMLElement;
    if (!viewport || !card) return;

    const cardWidth = card.offsetWidth;
    const gap = 16; // $gap = 1rem = 16px
    const scrollAmount = cardWidth + gap;

    viewport.scrollBy({ left: scrollAmount, behavior: 'smooth' });
  }

  /**
   * Update nav button visibility based on scroll position
   */
  private updateNavButtons(): void {
    const viewport = this.element.querySelector('.profile-articles-carousel__viewport') as HTMLElement;
    const prevBtn = this.element.querySelector('.profile-articles-carousel__nav-btn--prev') as HTMLElement;
    const nextBtn = this.element.querySelector('.profile-articles-carousel__nav-btn--next') as HTMLElement;

    if (!viewport || !prevBtn || !nextBtn) return;

    const isAtStart = viewport.scrollLeft <= 0;
    // Disable next button only if less than half a card width remains
    const remainingScroll = viewport.scrollWidth - (viewport.scrollLeft + viewport.clientWidth);
    const isAtEnd = remainingScroll < 140; // Half of 280px card width

    prevBtn.classList.toggle('profile-articles-carousel__nav-btn--disabled', isAtStart);
    nextBtn.classList.toggle('profile-articles-carousel__nav-btn--disabled', isAtEnd);
  }

  /**
   * Escape HTML
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Get the element
   */
  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Check if carousel has articles
   */
  public hasArticles(): boolean {
    return this.articles.length > 0;
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    this.element.remove();
  }
}
