/**
 * ProfileArticlesCarousel Component
 * Displays a user's long-form articles (NIP-23, kind:30023) in a horizontal carousel.
 * On own profile: also shows drafts (kind:30024) with a "Draft" badge.
 *
 * @component ProfileArticlesCarousel
 * @used-by ProfileView
 */

import { ModuleLoader } from '../../core/ModuleLoader';
import type {
  ArticlesModuleApi,
  ArticleMetadata,
} from '../../modules/articles/contracts';
import type {
  ProfileModuleApi,
  ProfileCarouselContent,
} from '../../modules/profile/contracts';
import { UserProfileService } from '../../services/UserProfileService';
import { AuthService } from '../../services/AuthService';
import { Router } from '../../services/Router';
import { encodeNaddr } from '../../services/NostrToolsAdapter';
import {
  createCardGrid,
  type ScrollCarouselInstance,
} from '../../helpers/CarouselHelper';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { extractDisplayName } from '../../helpers/extractDisplayName';

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
  private _profileApi: ProfileModuleApi | null = null;
  private get profileApi(): ProfileModuleApi {
    const api = (this._profileApi ??=
      ModuleLoader.getInstance().getApi<ProfileModuleApi>('profile'));
    if (!api) {
      throw new Error('Profile module API not available');
    }
    return api;
  }
  private userProfileService: UserProfileService;
  private carousel: ScrollCarouselInstance | null = null;
  private isOwnProfile: boolean;

  constructor(pubkey: string) {
    this.pubkey = pubkey;
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
    try {
      // Fetch published articles (+ drafts for own profile)
      const kinds = this.isOwnProfile ? [30023, 30024] : [30023];

      // Single shared fetch (read + aggregator + outbound relays) via the
      // profile module. Read-relays-only previously hid articles that
      // live only on the author's NIP-65 write relays; the fetch also
      // returns the author's kind:5 deletions (for the tombstone filter below)
      // and is reused by the videos/listings carousels from one cached fetch.
      const content: ProfileCarouselContent =
        await this.profileApi.fetchCarouselContent(this.pubkey);
      const rawEvents = content.articles;
      const deletionEvents = content.deletions;
      const hintRelays = content.hintRelays;

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
        const aPublished = parseInt(
          a.tags.find(t => t[0] === 'published_at')?.[1] || String(a.created_at)
        );
        const bPublished = parseInt(
          b.tags.find(t => t[0] === 'published_at')?.[1] || String(b.created_at)
        );
        return bPublished - aPublished;
      });

      // Ensure the articles module is loaded before extracting metadata —
      // ensure() loads it on demand in any boot context; in-app it is already
      // loaded and resolves instantly.
      const articlesApi =
        await ModuleLoader.getInstance().ensure<ArticlesModuleApi>('articles');

      this.articles = events.map(event => {
        const isDraft = event.kind === 30024;
        const metadata = articlesApi?.extractArticleMetadata(event) ?? {
          title: '',
          image: '',
          summary: '',
          publishedAt: 0,
          identifier: '',
          topics: [],
        };
        const naddr = encodeNaddr({
          kind: event.kind!,
          pubkey: event.pubkey,
          identifier: metadata.identifier,
          relays: hintRelays,
        });
        return { event, metadata, naddr, isDraft };
      });

      // Drafts first, then published (within each group: newest first)
      if (this.isOwnProfile) {
        this.articles.sort((a, b) => {
          if (a.isDraft !== b.isDraft) return a.isDraft ? -1 : 1;
          const aTime = parseInt(
            a.event.tags.find(t => t[0] === 'published_at')?.[1] ||
              String(a.event.created_at)
          );
          const bTime = parseInt(
            b.event.tags.find(t => t[0] === 'published_at')?.[1] ||
              String(b.event.created_at)
          );
          return bTime - aTime;
        });
      }

      // Log article image URLs for debugging
      const { diagLog } = await import('../../services/DiagnosticLogger');
      diagLog('system', 'ArticlesCarousel: loaded', {
        count: this.articles.length,
        drafts: this.articles.filter(a => a.isDraft).length,
        images: this.articles.map(a => ({
          title: a.metadata.title?.slice(0, 30),
          image: a.metadata.image || 'none',
        })),
      });
    } catch (error) {
      console.error(
        '[ProfileArticlesCarousel] Failed to fetch articles:',
        error
      );
      this.articles = [];
    }
  }

  private renderCarousel(): void {
    const authorName = this.getAuthorDisplayName();

    const cards = this.articles.map(article => {
      const { metadata, naddr, isDraft } = article;

      const date = new Date(metadata.publishedAt * 1000);
      const formattedDate = date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });

      const draftBadge = isDraft
        ? '<span class="badge badge--warning badge--overlay">Draft</span>'
        : '';

      const mediaHtml = metadata.image
        ? `<div class="nn-card__media">${draftBadge}<img src="${escapeHtmlAttr(metadata.image)}" alt="" loading="lazy" /></div>`
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
        data: { naddr, isDraft: isDraft ? 'true' : 'false' },
      };
    });

    this.carousel = createCardGrid({
      cards,
      onCardClick: (_index, data) => {
        if (!data.naddr) return;
        const route =
          data.isDraft === 'true'
            ? `/edit-article/${data.naddr}`
            : `/article/${data.naddr}`;
        Router.getInstance().navigate(route);
      },
    });

    this.element.appendChild(this.carousel.element);
  }

  private authorName: string = '';

  private async fetchAuthorName(): Promise<void> {
    if (this.authorName) return;
    try {
      const profile = await this.userProfileService.getUserProfile(this.pubkey);
      this.authorName = extractDisplayName(profile) || 'Anonymous';
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
