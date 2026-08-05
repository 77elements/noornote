/**
 * ArticleTimeline — unified chronological feed of kind 30023 articles from
 * the current user's follows.
 *
 * Two variants share this component:
 *   • `main` — the primary `/articles` view (20-per-page grid, full cards
 *     with title + summary + topics, right-pane-aware click navigation)
 *   • `scc`  — the secondary-column "Newest Articles" tab (7-per-page list,
 *     compact cards with title + excerpt, plain router navigation, honours
 *     the user's SCC_ARTICLE_EXCERPT_LIMIT setting)
 *
 * The fetch/dedup/sort pipeline lives in `ArticleFeedOrchestrator.fetchFollowingArticles`
 * — this component only owns its pagination cursor and seen-set.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { ArticlesModuleApi, ArticleFeedFetchOptions } from '../../modules/articles/contracts';
import { FoafService } from '../../services/foaf';
import { TypedEventBus } from '../../core/TypedEventBus';
import type { ArticleFoafDegreeChangedPayload } from '../../core/events';
import { UserProfileService } from '../../services/UserProfileService';
import { InfiniteScroll } from '../ui/InfiniteScroll';
import { encodeNaddr } from '../../services/NostrToolsAdapter';
import { hexToNpub } from '../../helpers/nip19';
import { formatTimestamp } from '../../helpers/formatTimestamp';
import { setupUserMentionHandlers } from '../../helpers/UserMentionHelper';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { PerAccountLocalStorage, StorageKeys, type StorageKey } from '../../services/PerAccountLocalStorage';

export type ArticleTimelineVariant = 'main' | 'scc';

export interface ArticleTimelineConfig {
  variant: ArticleTimelineVariant;
  /** Click handler — receives the article's naddr and the original click
   *  event. Main variant routes through ViewNavigationController (right-pane
   *  aware, uses the event for modifier-key detection); SCC routes through
   *  Router. Wired by the caller. */
  onNavigate: (naddr: string, clickEvent: MouseEvent) => void;
}

const PAGE_SIZE_BY_VARIANT: Record<ArticleTimelineVariant, number> = {
  main: 20,
  scc: 7,
};

const STORAGE_KEY_BY_VARIANT: Record<ArticleTimelineVariant, StorageKey> = {
  main: StorageKeys.ARTICLE_FEED_FOAF_DEGREE_MAIN,
  scc: StorageKeys.ARTICLE_FEED_FOAF_DEGREE_SCC,
};

/**
 * Cap on the number of authors the feed queries per session. FOAF degree 2+
 * can yield tens of thousands of pubkeys (e.g. 421 follows → ~28k degree-2);
 * querying all of them per page is too slow even with parallel batching.
 * We sample this many once per session (Fisher-Yates) and stick with the
 * sample until the user changes the degree or reloads the view, so the
 * pagination cursor and seen-set stay coherent within a session.
 */
const MAX_FOAF_AUTHORS_PER_SESSION = 500;

export class ArticleTimeline {
  private readonly config: ArticleTimelineConfig;
  private readonly pageSize: number;
  private readonly userProfileService = UserProfileService.getInstance();

  private element: HTMLElement;
  private articlesContainer: HTMLElement;
  private infiniteScroll: InfiniteScroll;

  private articles: NostrEvent[] = [];
  private seenIds = new Set<string>();
  private oldestTimestamp = Math.floor(Date.now() / 1000);
  private isLoading = false;
  private hasMore = true;
  private settingsSubscription: string | null = null;
  /** Backup scroll listener on the resolved scroll root. IntersectionObserver
   *  is the primary trigger but in nested-scroller layouts (article view
   *  inside `.tab-content--active` inside `.primary-content`) it can miss
   *  fires when the sentinel briefly enters and exits during fast scrolls.
   *  This listener is the safety net. */
  private scrollRootListener: ((e: Event) => void) | null = null;
  private scrollRootAttached: Element | null = null;
  /** Cached sample of authors for the current session. Refilled on first
   *  fetchPage() call after construction or resetState(). When the FOAF
   *  degree produces a set larger than MAX_FOAF_AUTHORS_PER_SESSION, a
   *  random subset is drawn and reused across pages so the pagination
   *  cursor and seen-set stay coherent within the session. */
  private sampledAuthors: string[] | null = null;

  constructor(config: ArticleTimelineConfig) {
    this.config = config;
    this.pageSize = PAGE_SIZE_BY_VARIANT[config.variant];
    this.element = this.createElement();
    this.articlesContainer = this.element.querySelector(
      this.config.variant === 'main'
        ? '.article-timeline__list'
        : '.scc-article-feed'
    ) as HTMLElement;

    this.infiniteScroll = new InfiniteScroll(
      () => this.handleLoadMore(),
      { loadingMessage: 'Loading articles...', rootMargin: '300px' }
    );

    // Live-reload when the user picks a different FOAF degree for this surface.
    this.settingsSubscription = TypedEventBus.getInstance().on(
      'settings:article-foaf-degree-changed',
      (payload: ArticleFoafDegreeChangedPayload) => {
        if (payload.variant !== this.config.variant) return;
        this.resetState();
        this.loadInitial();
      }
    );

    this.loadInitial();
  }

  /** Lazy getter (never cache getApi in the constructor — avoids null-forever timing bugs). */
  private get articlesApi(): ArticlesModuleApi | null {
    return ModuleLoader.getInstance().getApi<ArticlesModuleApi>('articles');
  }

  /**
   * Walk up the DOM from `articlesContainer` and return the first ancestor
   * that actually scrolls (overflow-y auto/scroll AND content overflows).
   * Returns null if none found — caller falls back to viewport-root IO.
   *
   * Necessary because /articles renders inside `.tab-content--active`, which
   * is the real scroll container — not `.primary-content` and not the window.
   * With the default viewport root, the IntersectionObserver never sees the
   * sentinel come into view (it stays hidden inside the inner scroller) and
   * pagination silently stops after the first page.
   */
  private findScrollRoot(): Element | null {
    let el = this.articlesContainer.parentElement;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      const canScroll = style.overflowY === 'auto' || style.overflowY === 'scroll';
      if (canScroll && el.scrollHeight > el.clientHeight) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    if (this.settingsSubscription) {
      TypedEventBus.getInstance().off(this.settingsSubscription);
      this.settingsSubscription = null;
    }
    this.detachScrollRootListener();
    this.infiniteScroll.destroy();
    this.element.innerHTML = '';
    this.articles = [];
    this.seenIds.clear();
    this.sampledAuthors = null;
  }

  /**
   * Attach a direct scroll listener to the resolved scroll root. Acts as a
   * safety net alongside IntersectionObserver — IO is the primary trigger
   * but has known blind spots in nested-scroller layouts. Idempotent.
   */
  private attachScrollRootListener(root: Element): void {
    if (this.scrollRootAttached === root) return;
    this.detachScrollRootListener();
    this.scrollRootListener = () => this.checkScrollNearBottom(root);
    root.addEventListener('scroll', this.scrollRootListener, { passive: true });
    this.scrollRootAttached = root;
  }

  private detachScrollRootListener(): void {
    if (this.scrollRootListener && this.scrollRootAttached) {
      this.scrollRootAttached.removeEventListener('scroll', this.scrollRootListener);
    }
    this.scrollRootListener = null;
    this.scrollRootAttached = null;
  }

  /**
   * Manual bottom-detection: if the scroll root is within `margin` pixels
   * of its bottom, fire handleLoadMore. Mirrors the IntersectionObserver's
   * rootMargin pre-fetch distance.
   */
  private checkScrollNearBottom(root: Element): void {
    if (this.isLoading || !this.hasMore) return;
    const margin = 300;
    const remaining = root.scrollHeight - root.clientHeight - root.scrollTop;
    if (remaining <= margin) {
      this.handleLoadMore();
    }
  }

  private resetState(): void {
    this.articles = [];
    this.seenIds.clear();
    this.oldestTimestamp = Math.floor(Date.now() / 1000);
    this.hasMore = true;
    this.isLoading = false;
    this.sampledAuthors = null;
  }

  /**
   * Resolve the author list to fetch articles from, based on this surface's
   * configured FOAF degree.
   *  • 1 — direct follows (cheap, always available)
   *  • 2 — friends-of-friends (built on demand via FoafService, slow first time)
   *  • 3 — friends-of-friends-of-friends (very slow first time, huge set)
   *
   * Result is cached per-session in `sampledAuthors`. Subsequent pages within
   * the same session reuse the same sample so the pagination cursor and
   * seen-set stay coherent.
   */
  private async resolveAuthors(): Promise<string[]> {
    if (this.sampledAuthors !== null) return this.sampledAuthors;

    const storageKey = STORAGE_KEY_BY_VARIANT[this.config.variant];
    const degree = PerAccountLocalStorage.getInstance().get<number>(storageKey, 1);

    let authors: string[];
    if (degree <= 1) {
      // Avoid the FoafService hop for the common case — direct follows are
      // already in memory via FollowCheckService / lists/follows.
      const { getAllFollowedPubkeys } = await import('../../lists/follows');
      authors = getAllFollowedPubkeys();
    } else {
      const set = await FoafService.getInstance().getFoaf(degree as 1 | 2 | 3);
      authors = [...set];
    }

    // Always merge in article-alert subscriptions — these are explicit
    // author subscriptions that exist independently of the FOAF degree
    // setting (the user may have alerts on for someone they don't follow).
    const alertSubs =
      ModuleLoader.getInstance().getApi<ArticlesModuleApi>('articles')?.getSubscribedArticlePubkeys() ?? [];
    if (alertSubs.length > 0) {
      const seen = new Set(authors);
      for (const pk of alertSubs) {
        if (!seen.has(pk)) authors.push(pk);
      }
    }

    // Cap large FOAF sets via Fisher-Yates partial shuffle.
    if (authors.length > MAX_FOAF_AUTHORS_PER_SESSION) {
      const sample = authors.slice(0, MAX_FOAF_AUTHORS_PER_SESSION);
      for (let i = MAX_FOAF_AUTHORS_PER_SESSION; i < authors.length; i++) {
        const j = Math.floor(Math.random() * (i + 1));
        if (j < MAX_FOAF_AUTHORS_PER_SESSION) sample[j] = authors[i]!;
      }
      authors = sample;
    }

    this.sampledAuthors = authors;
    return authors;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DOM scaffold — variant-specific container only; cards are unified
  // ─────────────────────────────────────────────────────────────────────────

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    if (this.config.variant === 'main') {
      container.className = 'article-timeline';
      container.innerHTML = `<div class="article-timeline__list nn-card-grid nn-card-grid--nonresponsive"></div>`;
    } else {
      container.className = 'scc-article-feed-wrap';
      container.innerHTML = `<div class="scc-article-feed"></div>`;
    }
    return container;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Loading lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  private async loadInitial(): Promise<void> {
    this.showLoading();

    const result = await this.fetchPage();
    if (result.length === 0) {
      this.showEmpty();
      return;
    }

    this.articlesContainer.innerHTML = '';
    this.renderArticles(result);
    // Pass the actual scroll container as IntersectionObserver root —
    // critical for layouts where articles render inside an inner scroller
    // (e.g. `.tab-content--active` on /articles). Default viewport root
    // would never see the sentinel enter view.
    const scrollRoot = this.findScrollRoot();
    this.infiniteScroll.observe(this.articlesContainer, scrollRoot);
    // Safety-net scroll listener on the same root (IO alone is unreliable
    // in nested-scroller layouts).
    if (scrollRoot) this.attachScrollRootListener(scrollRoot);
  }

  private async handleLoadMore(): Promise<void> {
    // Already fetching — never disconnect the observer on `isLoading` alone,
    // it must stay alive so the next scroll after the in-flight fetch lands
    // re-triggers loadMore.
    if (this.isLoading) return;
    // hasMore=false: stop paginating, but leave the sentinel in the DOM so
    // we don't rip the observer out from under a future re-load.
    if (!this.hasMore) return;
    this.isLoading = true;
    this.infiniteScroll.showLoading();

    try {
      const result = await this.fetchPage();
      if (result.length === 0) {
        // Empty page — orchestrator left the cursor unchanged, so the next
        // call would hit the exact same window and return 0 again. Jump the
        // cursor back so the next scroll retrigger lands in a different
        // window. Don't declare hasMore=false — FOAF samples can have gaps
        // and the user scrolling further is the natural signal to keep
        // looking. The cursor jump prevents infinite empty loops because
        // eventually we move past the authors' activity window entirely
        // (returns 0 even after jump) and the user simply stops scrolling.
        this.oldestTimestamp -= 7 * 24 * 60 * 60;
      } else {
        this.appendArticles(result);
      }
      this.infiniteScroll.hideLoading();
    } catch {
      this.infiniteScroll.hideLoading();
    } finally {
      this.isLoading = false;
    }
  }

  private async fetchPage(): Promise<NostrEvent[]> {
    const follows = await this.resolveAuthors();
    if (follows.length === 0) return [];

    const api = this.articlesApi;
    if (!api) return [];

    const opts: ArticleFeedFetchOptions = {
      authors: follows,
      until: this.oldestTimestamp,
      limit: this.pageSize,
      excludeIds: this.seenIds,
    };
    const result = await api.fetchFollowingArticles(opts);

    for (const article of result.articles) {
      this.seenIds.add(api.getArticleAddressableId(article));
      this.articles.push(article);
    }

    this.oldestTimestamp = result.oldestTimestamp;
    return result.articles;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Rendering
  // ─────────────────────────────────────────────────────────────────────────

  private renderArticles(articles: NostrEvent[]): void {
    this.articlesContainer.innerHTML = '';
    articles.forEach(article => {
      this.articlesContainer.appendChild(this.createCard(article));
    });
  }

  private appendArticles(articles: NostrEvent[]): void {
    const sentinel = this.articlesContainer.querySelector('.infinite-scroll-sentinel');
    for (const article of articles) {
      const card = this.createCard(article);
      if (sentinel) {
        this.articlesContainer.insertBefore(card, sentinel);
      } else {
        this.articlesContainer.appendChild(card);
      }
    }
  }

  private createCard(event: NostrEvent): HTMLElement {
    const api = this.articlesApi;
    const metadata = api?.extractArticleFeedMetadata(event) ?? { title: '', summary: '', image: '', identifier: '', publishedAt: 0, topics: [] };
    const naddr = encodeNaddr({
      kind: 30023,
      pubkey: event.pubkey,
      identifier: metadata.identifier,
      relays: [],
    });

    const isMain = this.config.variant === 'main';
    const card = document.createElement('article');
    card.className = isMain ? 'nn-card' : 'nn-card scc-article-card';

    const titleTag = isMain ? 'h2' : 'h3';
    const titleClass = isMain ? '' : 'nn-card__title';
    const summaryHtml = isMain
      ? (metadata.summary ? `<p class="summary">${escapeHtml(metadata.summary)}</p>` : '')
      : this.renderExcerpt(event.content || '');
    const topicsHtml = isMain && metadata.topics.length > 0
      ? `<div class="tags">${metadata.topics.slice(0, 3).map(t => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}</div>`
      : '';

    card.innerHTML = `
      ${metadata.image ? `
        <div class="nn-card__media">
          <img src="${escapeHtmlAttr(metadata.image)}" alt="" loading="lazy" />
        </div>
      ` : ''}
      <div class="nn-card__content">
        <${titleTag} class="${titleClass}">${escapeHtml(metadata.title || 'Untitled')}</${titleTag}>
        ${summaryHtml}
        <div class="nn-card__meta">
          <span class="author user-mention" data-pubkey="${event.pubkey}">
            <a href="/profile/${hexToNpub(event.pubkey)}" class="mention-link" data-profile-pubkey="${event.pubkey}">
              <img class="profile-pic profile-pic--mini" src="" alt="" />...</a>
          </span>
          <span>${formatTimestamp(metadata.publishedAt || event.created_at || 0)}</span>
        </div>
        ${topicsHtml}
      </div>
    `;

    card.style.cursor = 'pointer';
    card.addEventListener('click', (e: MouseEvent) => {
      // Let inner links (author handle) work natively.
      const target = e.target as HTMLElement;
      if (target.closest('a')) return;
      this.config.onNavigate(naddr, e);
    });

    this.loadAuthorInfo(card, event.pubkey);
    return card;
  }

  /**
   * SCC-only: strip markdown to a plain excerpt, length capped by the user's
   * SCC_ARTICLE_EXCERPT_LIMIT setting (default 200).
   */
  private renderExcerpt(content: string): string {
    const limit = PerAccountLocalStorage.getInstance().get<number>(
      StorageKeys.SCC_ARTICLE_EXCERPT_LIMIT,
      200
    );
    const stripped = content
      .replace(/^#+\s.*/gm, '')
      .replace(/!\[.*?\]\(.*?\)/g, '')
      .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')
      .replace(/[*_~`]/g, '')
      .trim();

    const firstParagraph = stripped.split(/\n\s*\n/)[0]?.trim() || '';
    const excerpt = firstParagraph.length <= limit
      ? firstParagraph
      : firstParagraph.slice(0, limit).replace(/\s+\S*$/, '') + '...';
    return excerpt ? `<p class="scc-article-card__excerpt">${escapeHtml(excerpt)}</p>` : '';
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

  // ─────────────────────────────────────────────────────────────────────────
  // Loading / empty states
  // ─────────────────────────────────────────────────────────────────────────

  private showLoading(): void {
    this.articlesContainer.innerHTML = '<p class="pulsate">Loading articles...</p>';
  }

  private showEmpty(): void {
    if (this.config.variant === 'main') {
      this.articlesContainer.innerHTML = `
        <div class="article-timeline__empty">
          <svg width="48" height="48"><use href="#icon-articles"/></svg>
          <p>No articles found</p>
          <span>Long-form articles will appear here</span>
        </div>
      `;
    } else {
      this.articlesContainer.innerHTML =
        '<p class="scc-article-feed__empty">No articles from your follows yet.</p>';
    }
  }
}
