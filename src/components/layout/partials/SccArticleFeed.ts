import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { getAllFollowedPubkeys } from '../../../lists/follows';
import { fetchEvents } from '../../../lists/relays';
import { ModuleLoader } from '../../../core/ModuleLoader';
import type { ArticlesModuleApi } from '../../../modules/articles/contracts';
import { UserProfileService } from '../../../services/UserProfileService';
import { Router } from '../../../services/Router';
import { InfiniteScroll } from '../../ui/InfiniteScroll';
import { encodeNaddr } from '../../../services/NostrToolsAdapter';
import { hexToNpub } from '../../../helpers/nip19';
import { formatTimestamp } from '../../../helpers/formatTimestamp';
import { setupUserMentionHandlers } from '../../../helpers/UserMentionHelper';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';

const BATCH_SIZE = 7;

export class SccArticleFeed {
  private container: HTMLElement;
  private listEl: HTMLElement;
  private infiniteScroll: InfiniteScroll;
  private userProfileService: UserProfileService;
  private router: Router;
  private articles: NostrEvent[] = [];
  private seenIds = new Set<string>();
  private oldestTimestamp = Math.floor(Date.now() / 1000);
  private isLoading = false;
  private hasMore = true;

  constructor(container: HTMLElement) {
    this.container = container;
    this.userProfileService = UserProfileService.getInstance();
    this.router = Router.getInstance();

    this.listEl = document.createElement('div');
    this.listEl.className = 'scc-article-feed';
    this.container.appendChild(this.listEl);

    this.infiniteScroll = new InfiniteScroll(
      () => this.loadMore(),
      { loadingMessage: 'Loading articles...', rootMargin: '300px' }
    );

    this.loadInitial();
  }

  private async loadInitial(): Promise<void> {
    const follows = getAllFollowedPubkeys();
    if (follows.length === 0) {
      this.listEl.innerHTML = '<p class="scc-article-feed__empty">Follow authors to see their articles here.</p>';
      return;
    }

    this.listEl.innerHTML = '<p class="pulsate">Loading articles...</p>';

    const events = await this.fetchArticles(follows);
    this.listEl.innerHTML = '';

    if (events.length === 0) {
      this.listEl.innerHTML = '<p class="scc-article-feed__empty">No articles from your follows yet.</p>';
      return;
    }

    this.renderArticles(events);
    this.infiniteScroll.observe(this.listEl);

    if (events.length < BATCH_SIZE) {
      this.hasMore = false;
      this.infiniteScroll.disconnect();
    }
  }

  private async loadMore(): Promise<void> {
    if (this.isLoading || !this.hasMore) return;
    this.isLoading = true;
    this.infiniteScroll.showLoading();

    try {
      const follows = getAllFollowedPubkeys();
      const events = await this.fetchArticles(follows);

      if (events.length === 0) {
        this.hasMore = false;
        this.infiniteScroll.disconnect();
      } else {
        this.appendArticles(events);
        if (events.length < BATCH_SIZE) {
          this.hasMore = false;
          this.infiniteScroll.disconnect();
        } else {
          this.infiniteScroll.hideLoading();
        }
      }
    } catch {
      this.infiniteScroll.hideLoading();
    } finally {
      this.isLoading = false;
    }
  }

  private async fetchArticles(authors: string[]): Promise<NostrEvent[]> {
    const batchSize = 150;
    const allEvents: NostrEvent[] = [];

    for (let i = 0; i < authors.length; i += batchSize) {
      const batch = authors.slice(i, i + batchSize);
      const events = await fetchEvents([{
        kinds: [30023],
        authors: batch,
        until: this.oldestTimestamp,
        limit: BATCH_SIZE + 5
      }], 8000);
      allEvents.push(...events);
    }

    const deduped = this.deduplicateAndSort(allEvents);
    const fresh = deduped.filter(e => !this.seenIds.has(this.getAddressableId(e)));

    fresh.forEach(e => {
      this.seenIds.add(this.getAddressableId(e));
      this.articles.push(e);
    });

    if (fresh.length > 0) {
      this.oldestTimestamp = (fresh[fresh.length - 1]!.created_at ?? this.oldestTimestamp) - 1;
    }

    return fresh.slice(0, BATCH_SIZE);
  }

  private getAddressableId(event: NostrEvent): string {
    const dTag = event.tags?.find(t => t[0] === 'd')?.[1] || '';
    return `${event.pubkey}:${dTag}`;
  }

  private deduplicateAndSort(events: NostrEvent[]): NostrEvent[] {
    const best = new Map<string, NostrEvent>();
    for (const e of events) {
      const id = this.getAddressableId(e);
      const existing = best.get(id);
      if (!existing || (e.created_at || 0) > (existing.created_at || 0)) {
        best.set(id, e);
      }
    }
    return [...best.values()].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  }

  private renderArticles(articles: NostrEvent[]): void {
    articles.forEach(article => {
      this.listEl.appendChild(this.createCard(article));
    });
  }

  private appendArticles(articles: NostrEvent[]): void {
    const sentinel = this.listEl.querySelector('.infinite-scroll-sentinel');
    articles.forEach(article => {
      const card = this.createCard(article);
      if (sentinel) {
        this.listEl.insertBefore(card, sentinel);
      } else {
        this.listEl.appendChild(card);
      }
    });
  }

  private createCard(event: NostrEvent): HTMLElement {
    const articlesApi = ModuleLoader.getInstance().getApi<ArticlesModuleApi>('articles');
    const metadata = articlesApi?.extractArticleMetadata(event) ?? { title: '', summary: '', image: '', identifier: '', publishedAt: 0, topics: [] };
    const excerpt = this.extractExcerpt(event.content || '', 200);
    const naddr = encodeNaddr({
      kind: 30023,
      pubkey: event.pubkey,
      identifier: metadata.identifier,
      relays: []
    });

    const card = document.createElement('article');
    card.className = 'nn-card scc-article-card';

    card.innerHTML = `
      ${metadata.image ? `
        <div class="nn-card__media">
          <img src="${escapeHtmlAttr(metadata.image)}" alt="" loading="lazy" />
        </div>
      ` : ''}
      <div class="nn-card__content">
        <h3 class="nn-card__title">${escapeHtml(metadata.title || 'Untitled')}</h3>
        ${excerpt ? `<p class="scc-article-card__excerpt">${escapeHtml(excerpt)}</p>` : ''}
        <div class="nn-card__meta">
          <span class="author" data-pubkey="${event.pubkey}">
            <a href="/profile/${hexToNpub(event.pubkey)}" class="mention-link" data-profile-pubkey="${event.pubkey}">
              <img class="profile-pic profile-pic--mini" src="" alt="" />...</a>
          </span>
          <span>${formatTimestamp(metadata.publishedAt || event.created_at || 0)}</span>
        </div>
      </div>
    `;

    card.addEventListener('click', () => {
      this.router.navigate(`/article/${naddr}`);
    });

    this.loadAuthorInfo(card, event.pubkey);

    return card;
  }

  private extractExcerpt(content: string, maxLength: number): string {
    const stripped = content
      .replace(/^#+\s.*/gm, '')
      .replace(/!\[.*?\]\(.*?\)/g, '')
      .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')
      .replace(/[*_~`]/g, '')
      .trim();

    const firstParagraph = stripped.split(/\n\s*\n/)[0]?.trim() || '';
    if (firstParagraph.length <= maxLength) return firstParagraph;
    return firstParagraph.slice(0, maxLength).replace(/\s+\S*$/, '') + '...';
  }

  private async loadAuthorInfo(card: HTMLElement, pubkey: string): Promise<void> {
    const authorEl = card.querySelector('.author');
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
          <img class="profile-pic profile-pic--mini" src="" alt="" />${npub.slice(0, 12)}...</a>
      `;
    }

    setupUserMentionHandlers(authorEl as HTMLElement);
  }

  public destroy(): void {
    this.infiniteScroll.destroy();
    this.container.innerHTML = '';
    this.articles = [];
    this.seenIds.clear();
  }
}
