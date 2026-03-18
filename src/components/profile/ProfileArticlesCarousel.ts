/**
 * ProfileArticlesCarousel Component
 * Displays a user's long-form articles (NIP-23, kind:30023) in a horizontal carousel.
 *
 * @component ProfileArticlesCarousel
 * @used-by ProfileView
 */

import { NostrTransport } from '../../services/transport/NostrTransport';
import { LongFormOrchestrator, type ArticleMetadata } from '../../services/orchestration/LongFormOrchestrator';
import { UserProfileService } from '../../services/UserProfileService';
import { Router } from '../../services/Router';
import { encodeNaddr } from '../../services/NostrToolsAdapter';
import { createScrollCarousel, type ScrollCarouselInstance } from '../../helpers/CarouselHelper';
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
  private carousel: ScrollCarouselInstance | null = null;

  constructor(pubkey: string) {
    this.pubkey = pubkey;
    this.transport = NostrTransport.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.element = document.createElement('div');
    this.element.className = 'profile-articles-carousel';
  }

  /**
   * Fetch articles and render the carousel
   */
  public async render(): Promise<HTMLElement> {
    await this.fetchArticles();

    if (this.articles.length === 0) {
      this.element.style.display = 'none';
      return this.element;
    }

    await this.fetchAuthorName();
    this.renderCarousel();

    return this.element;
  }

  private async fetchArticles(): Promise<void> {
    const relays = this.transport.getReadRelays();

    try {
      const events = await this.transport.fetch(relays, [{
        kinds: [30023],
        authors: [this.pubkey],
        limit: 20
      }], 8000);

      events.sort((a, b) => {
        const aPublished = parseInt(a.tags.find(t => t[0] === 'published_at')?.[1] || String(a.created_at));
        const bPublished = parseInt(b.tags.find(t => t[0] === 'published_at')?.[1] || String(b.created_at));
        return bPublished - aPublished;
      });

      this.articles = events.map(event => {
        const metadata = LongFormOrchestrator.extractArticleMetadata(event);
        const naddr = encodeNaddr({
          kind: 30023,
          pubkey: event.pubkey,
          identifier: metadata.identifier,
          relays: relays.slice(0, 2)
        });
        return { event, metadata, naddr };
      });
    } catch (error) {
      console.error('[ProfileArticlesCarousel] Failed to fetch articles:', error);
      this.articles = [];
    }
  }

  private renderCarousel(): void {
    const authorName = this.getAuthorDisplayName();

    const cards = this.articles.map(article => {
      const { metadata, naddr } = article;

      const date = new Date(metadata.publishedAt * 1000);
      const formattedDate = date.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
      });

      const imageHtml = metadata.image
        ? `<div class="profile-articles-carousel__card-image" style="background-image: url('${this.escapeHtml(metadata.image)}')"></div>`
        : `<div class="profile-articles-carousel__card-image profile-articles-carousel__card-image--placeholder"></div>`;

      return {
        html: `
          ${imageHtml}
          <div class="profile-articles-carousel__card-content">
            <h3 class="profile-articles-carousel__card-title">${this.escapeHtml(metadata.title)}</h3>
            <div class="profile-articles-carousel__card-meta">
              <span>${this.escapeHtml(authorName)}</span>
              <span>·</span>
              <span>${formattedDate}</span>
            </div>
          </div>
        `,
        data: { naddr }
      };
    });

    this.carousel = createScrollCarousel({
      title: 'Articles',
      cards,
      onCardClick: (_index, data) => {
        if (data.naddr) {
          Router.getInstance().navigate(`/article/${data.naddr}`);
        }
      }
    });

    this.element.appendChild(this.carousel.element);
  }

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

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public hasArticles(): boolean {
    return this.articles.length > 0;
  }

  public destroy(): void {
    if (this.carousel) this.carousel.destroy();
    this.element.remove();
  }
}
