/**
 * ArticleTimeline Component
 * Displays a chronological feed of long-form articles (kind 30023)
 *
 * Self-contained component with its own orchestrator.
 * Can be easily disabled by removing route and sidebar entry.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { ArticleFeedOrchestrator } from '../../services/orchestration/ArticleFeedOrchestrator';
import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { InfiniteScroll } from '../ui/InfiniteScroll';
import { encodeNaddr } from '../../services/NostrToolsAdapter';
import { hexToNpub } from '../../helpers/nip19';
import { formatTimestamp } from '../../helpers/formatTimestamp';
import { setupUserMentionHandlers } from '../../helpers/UserMentionHelper';

export class ArticleTimeline {
  private element: HTMLElement;
  private feedOrchestrator: ArticleFeedOrchestrator;
  private userProfileService: UserProfileService;
  private router: Router;
  private infiniteScroll: InfiniteScroll;
  private articlesContainer: HTMLElement;
  private isLoading: boolean = false;
  private hasMore: boolean = true;

  constructor() {
    this.feedOrchestrator = ArticleFeedOrchestrator.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.router = Router.getInstance();
    this.element = this.createElement();
    this.articlesContainer = this.element.querySelector('.article-timeline__list') as HTMLElement;

    this.infiniteScroll = new InfiniteScroll(
      () => this.handleLoadMore(),
      { loadingMessage: 'Loading more articles...' }
    );

    this.initialize();
  }

  /**
   * Create the timeline element
   */
  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'article-timeline';
    container.innerHTML = `
      <div class="article-timeline__list"></div>
    `;
    return container;
  }

  /**
   * Initialize timeline
   */
  private async initialize(): Promise<void> {
    this.showLoading();

    try {
      const result = await this.feedOrchestrator.loadInitial();
      this.hasMore = result.hasMore;

      if (result.articles.length > 0) {
        this.renderArticles(result.articles);
        this.infiniteScroll.observe(this.articlesContainer);
      } else {
        this.showEmpty();
      }
    } catch (error) {
      this.showError();
    }
  }

  /**
   * Handle load more
   */
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

      if (result.articles.length > 0) {
        this.appendArticles(result.articles);
      }

      if (!this.hasMore) {
        this.infiniteScroll.disconnect();
      } else {
        this.infiniteScroll.hideLoading();
      }
    } catch (error) {
      this.infiniteScroll.hideLoading();
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Render articles
   */
  private renderArticles(articles: NostrEvent[]): void {
    this.articlesContainer.innerHTML = '';
    articles.forEach(article => {
      const card = this.createArticleCard(article);
      this.articlesContainer.appendChild(card);
    });
  }

  /**
   * Append articles
   */
  private appendArticles(articles: NostrEvent[]): void {
    const sentinel = this.articlesContainer.querySelector('.infinite-scroll-sentinel');
    articles.forEach(article => {
      const card = this.createArticleCard(article);
      if (sentinel) {
        this.articlesContainer.insertBefore(card, sentinel);
      } else {
        this.articlesContainer.appendChild(card);
      }
    });
  }

  /**
   * Create article card
   */
  private createArticleCard(event: NostrEvent): HTMLElement {
    const metadata = ArticleFeedOrchestrator.extractMetadata(event);
    const card = document.createElement('article');
    card.className = 'article-card';

    // Create naddr for navigation
    const naddr = encodeNaddr({
      kind: 30023,
      pubkey: event.pubkey,
      identifier: metadata.identifier,
      relays: []
    });

    card.innerHTML = `
      ${metadata.image ? `
        <div class="article-card__image">
          <img src="${this.escapeHtml(metadata.image)}" alt="" loading="lazy" />
        </div>
      ` : ''}
      <div class="article-card__content">
        <h3 class="article-card__title">${this.escapeHtml(metadata.title || 'Untitled')}</h3>
        ${metadata.summary ? `<p class="article-card__summary">${this.escapeHtml(metadata.summary)}</p>` : ''}
        <div class="article-card__meta">
          <span class="article-card__author user-mention" data-pubkey="${event.pubkey}">
            <a href="#" class="mention-link" data-profile-pubkey="${event.pubkey}">
              <img class="profile-pic profile-pic--mini" src="" alt="" />Loading...</a>
          </span>
          ${formatTimestamp(event.created_at || 0)}
        </div>
        ${metadata.topics.length > 0 ? `
          <div class="article-card__tags">
            ${metadata.topics.slice(0, 3).map(tag => `<span class="article-card__tag">#${this.escapeHtml(tag)}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `;

    // Make card clickable
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => {
      this.router.navigate(`/article/${naddr}`);
    });

    // Load author name
    this.loadAuthorName(card, event.pubkey);

    return card;
  }

  /**
   * Load author name and picture
   */
  private async loadAuthorName(card: HTMLElement, pubkey: string): Promise<void> {
    const authorEl = card.querySelector('.article-card__author');
    if (!authorEl) return;

    const npub = hexToNpub(pubkey) || pubkey;

    try {
      const profile = await this.userProfileService.getUserProfile(pubkey);
      const username = profile?.name || profile?.display_name || npub.slice(0, 12) + '...';
      const picture = profile?.picture || '';

      authorEl.innerHTML = `
        <a href="/profile/${npub}" class="mention-link" data-profile-pubkey="${pubkey}">
          <img class="profile-pic profile-pic--mini" src="${picture}" alt="" />${username}</a>
      `;
    } catch {
      authorEl.innerHTML = `
        <a href="/profile/${npub}" class="mention-link" data-profile-pubkey="${pubkey}">
          <img class="profile-pic profile-pic--mini" src="" alt="" />${npub.slice(0, 12)}...</a>
      `;
    }

    // Setup hover card
    setupUserMentionHandlers(authorEl as HTMLElement);
  }


  /**
   * Show loading state
   */
  private showLoading(): void {
    this.articlesContainer.innerHTML = `
      <div class="article-timeline__loading">
        <div class="article-card-skeleton">
          <div class="skeleton-image"></div>
          <div class="skeleton-content">
            <div class="skeleton-line skeleton-title"></div>
            <div class="skeleton-line skeleton-summary"></div>
            <div class="skeleton-line skeleton-meta"></div>
          </div>
        </div>
        <div class="article-card-skeleton">
          <div class="skeleton-image"></div>
          <div class="skeleton-content">
            <div class="skeleton-line skeleton-title"></div>
            <div class="skeleton-line skeleton-summary"></div>
            <div class="skeleton-line skeleton-meta"></div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Show empty state
   */
  private showEmpty(): void {
    this.articlesContainer.innerHTML = `
      <div class="article-timeline__empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
        <p>No articles found</p>
        <span>Long-form articles will appear here</span>
      </div>
    `;
  }

  /**
   * Show error state
   */
  private showError(): void {
    this.articlesContainer.innerHTML = `
      <div class="article-timeline__error">
        <p>Failed to load articles</p>
        <button class="btn btn--passive" data-action="retry">Retry</button>
      </div>
    `;

    const retryBtn = this.articlesContainer.querySelector('[data-action="retry"]');
    retryBtn?.addEventListener('click', () => this.initialize());
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
   * Get element
   */
  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Destroy
   */
  public destroy(): void {
    this.infiniteScroll.disconnect();
    this.element.innerHTML = '';
  }
}
