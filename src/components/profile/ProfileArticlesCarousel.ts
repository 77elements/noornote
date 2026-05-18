/**
 * ProfileArticlesCarousel Component
 * Displays a user's long-form articles (NIP-23, kind:30023) in a horizontal carousel.
 * On own profile: also shows drafts (kind:30024) with a "Draft" badge.
 *
 * @component ProfileArticlesCarousel
 * @used-by ProfileView
 */

import { NostrTransport } from '../../services/transport/NostrTransport';
import { LongFormOrchestrator, type ArticleMetadata } from '../../services/orchestration/LongFormOrchestrator';
import { UserProfileService } from '../../services/UserProfileService';
import { AuthService } from '../../services/AuthService';
import { Router } from '../../services/Router';
import { encodeNaddr } from '../../services/NostrToolsAdapter';
import { createScrollCarousel, type ScrollCarouselInstance } from '../../helpers/CarouselHelper';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { escapeHtml } from '../../helpers/escapeHtml';

interface ArticleCardData {
  event: NostrEvent;
  metadata: ArticleMetadata;
  naddr: string;
  isDraft: boolean;
}

export class ProfileArticlesCarousel {
  private element: HTMLElement;
  private pubkey: string;
  private articles: ArticleCardData[] = [];
  private transport: NostrTransport;
  private userProfileService: UserProfileService;
  private carousel: ScrollCarouselInstance | null = null;
  private isOwnProfile: boolean;

  constructor(pubkey: string) {
    this.pubkey = pubkey;
    this.transport = NostrTransport.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.element = document.createElement('div');
    this.element.className = 'profile-articles-carousel';

    this.isOwnProfile = AuthService.getInstance().isCurrentUser(this.pubkey);
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
      // Fetch published articles (+ drafts for own profile)
      const kinds = this.isOwnProfile ? [30023, 30024] : [30023];

      // Parallel: article events + the author's NIP-09 deletion requests.
      // Without the kind:5 leg, a deleted draft that some relays haven't
      // tombstoned still gets re-served from other relays and re-appears
      // here — even after the user explicitly hit Delete. Pattern mirrors
      // `bookmarks.ts:1695-1758` for kind:30003 lists.
      const [rawEvents, deletionEvents] = await Promise.all([
        this.transport.fetch(relays, [{
          kinds,
          authors: [this.pubkey],
          limit: 20
        }], 8000, false, 'ArticlesCarousel'),
        this.transport.fetch(relays, [{
          kinds: [5],
          authors: [this.pubkey],
          limit: 50
        }], 8000, false, 'ArticlesCarousel:deletions'),
      ]);

      // Index NIP-09 `a`-tag deletions targeting our addressable kinds
      // (30023 / 30024) for this pubkey. Map value = most recent
      // deletion's created_at, so resurrection events strictly newer
      // than the deletion stay visible (canonical NIP-09 behaviour).
      const deletedCoordinates = new Map<string, number>();
      const prefixes = kinds.map(k => `${k}:${this.pubkey}:`);
      for (const delEvent of deletionEvents) {
        for (const tag of delEvent.tags) {
          if (tag[0] !== 'a' || !tag[1]) continue;
          if (!prefixes.some(p => tag[1]!.startsWith(p))) continue;
          const coord = tag[1];
          const existing = deletedCoordinates.get(coord);
          if (!existing || delEvent.created_at > existing) {
            deletedCoordinates.set(coord, delEvent.created_at);
          }
        }
      }

      // Dedupe by addressable coordinate `<kind>:<pubkey>:<d>`. NDK's
      // own Set-dedup runs on event id, so two versions of the same
      // addressable slot served by different relays (or by one relay
      // that hasn't replaced) both reach this code. Keep latest
      // created_at per coord, then drop coords whose deletion is newer
      // than the surviving event.
      const eventsByCoord = new Map<string, NostrEvent>();
      for (const event of rawEvents) {
        const dTag = event.tags.find(t => t[0] === 'd')?.[1] ?? '';
        const coord = `${event.kind}:${event.pubkey}:${dTag}`;
        const existing = eventsByCoord.get(coord);
        if (!existing || event.created_at > existing.created_at) {
          eventsByCoord.set(coord, event);
        }
      }
      const events = Array.from(eventsByCoord.entries())
        .filter(([coord, event]) => {
          const delTs = deletedCoordinates.get(coord);
          return delTs === undefined || event.created_at > delTs;
        })
        .map(([, event]) => event);

      events.sort((a, b) => {
        const aPublished = parseInt(a.tags.find(t => t[0] === 'published_at')?.[1] || String(a.created_at));
        const bPublished = parseInt(b.tags.find(t => t[0] === 'published_at')?.[1] || String(b.created_at));
        return bPublished - aPublished;
      });

      this.articles = events.map(event => {
        const isDraft = event.kind === 30024;
        const metadata = LongFormOrchestrator.extractArticleMetadata(event);
        const naddr = encodeNaddr({
          kind: event.kind!,
          pubkey: event.pubkey,
          identifier: metadata.identifier,
          relays: relays.slice(0, 2)
        });
        return { event, metadata, naddr, isDraft };
      });

      // Drafts first, then published (within each group: newest first)
      if (this.isOwnProfile) {
        this.articles.sort((a, b) => {
          if (a.isDraft !== b.isDraft) return a.isDraft ? -1 : 1;
          const aTime = parseInt(a.event.tags.find(t => t[0] === 'published_at')?.[1] || String(a.event.created_at));
          const bTime = parseInt(b.event.tags.find(t => t[0] === 'published_at')?.[1] || String(b.event.created_at));
          return bTime - aTime;
        });
      }

      // Log article image URLs for debugging
      const { diagLog } = await import('../../services/DiagnosticLogger');
      diagLog('system', 'ArticlesCarousel: loaded', {
        count: this.articles.length,
        drafts: this.articles.filter(a => a.isDraft).length,
        images: this.articles.map(a => ({ title: a.metadata.title?.slice(0, 30), image: a.metadata.image || 'none' }))
      });
    } catch (error) {
      console.error('[ProfileArticlesCarousel] Failed to fetch articles:', error);
      this.articles = [];
    }
  }

  private renderCarousel(): void {
    const authorName = this.getAuthorDisplayName();

    const cards = this.articles.map(article => {
      const { metadata, naddr, isDraft } = article;

      const date = new Date(metadata.publishedAt * 1000);
      const formattedDate = date.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
      });

      const draftBadge = isDraft
        ? '<span class="badge badge--warning badge--overlay">Draft</span>'
        : '';

      const mediaHtml = metadata.image
        ? `<div class="nn-card__media">${draftBadge}<img src="${escapeHtml(metadata.image)}" alt="" loading="lazy" /></div>`
        : `<div class="nn-card__media nn-card__media--empty">${draftBadge}</div>`;

      return {
        html: `
          ${mediaHtml}
          <div class="nn-card__content">
            <h3>${escapeHtml(metadata.title)}</h3>
            <div class="meta">
              <span>${escapeHtml(authorName)}</span>
              <span>·</span>
              <span>${formattedDate}</span>
            </div>
          </div>
        `,
        data: { naddr, isDraft: isDraft ? 'true' : 'false' }
      };
    });

    this.carousel = createScrollCarousel({
      title: 'Articles',
      cards,
      onCardClick: (_index, data) => {
        if (!data.naddr) return;
        const route = data.isDraft === 'true'
          ? `/edit-article/${data.naddr}`
          : `/article/${data.naddr}`;
        // Public NosPress page has no MainLayout (setupUI is skipped),
        // so the in-app `Router.navigate` has no mount target. Full
        // page-load reboots through App.ts → setupUI → article view,
        // works for logged-in AND logged-out visitors (`/article/`
        // route has `requiresAuth: false`).
        if (document.documentElement.classList.contains('layout--public')) {
          window.location.href = route;
          return;
        }
        Router.getInstance().navigate(route);
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
