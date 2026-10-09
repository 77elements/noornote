/**
 * SccRecipeFeed — "Recipes" tab in the secondary column (scc).
 *
 * Shows kind-30023 recipe articles carrying the `zapcooking` discovery tag
 * (the de-facto recipe marker, see helpers/recipeTemplate.ts) from the
 * current user's follows, newest first, with infinite scroll. Mirrors
 * SccMediaFeed's batching/pagination and renders with the shared
 * `.scc-article-feed` card classes — same look as the "Newest Articles" tab.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { getAllFollowedPubkeys } from '../../../lists/follows';
import { fetchEvents } from '../../../lists/relays';
import { Router } from '../../../services/Router';
import { InfiniteScroll } from '../../ui/InfiniteScroll';
import { encodeNaddr } from '../../../services/NostrToolsAdapter';
import { hexToNpub } from '../../../helpers/nip19';
import { formatTimestamp } from '../../../helpers/formatTimestamp';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { getTag } from '../../../helpers/tagUtils';
import { loadAuthorMention } from '../../../helpers/authorMention';
import { diagLog } from '../../../services/DiagnosticLogger';
import { RECIPE_DISCOVERY_TAG } from '../../../helpers/recipeTemplate';

const BATCH_SIZE = 10;
const AUTHOR_BATCH_SIZE = 150;

export class SccRecipeFeed {
  private container: HTMLElement;
  private gridEl: HTMLElement;
  private infiniteScroll: InfiniteScroll;
  private router: Router;
  private seenIds = new Set<string>();
  /** Coordinate (`kind:pubkey:d`) → newest event seen. Replaceable recipes
   *  re-published under the same coordinate must not show twice. */
  private newestByCoord = new Map<string, NostrEvent>();
  private oldestTimestamp = Math.floor(Date.now() / 1000);
  private isLoading = false;
  private hasMore = true;

  constructor(container: HTMLElement) {
    this.container = container;
    this.router = Router.getInstance();

    this.gridEl = document.createElement('div');
    this.gridEl.className = 'scc-article-feed';
    this.container.appendChild(this.gridEl);

    this.infiniteScroll = new InfiniteScroll(() => this.loadMore(), {
      loadingMessage: 'Loading recipes...',
      rootMargin: '400px',
    });

    void this.loadInitial();
  }

  private async loadInitial(): Promise<void> {
    const follows = getAllFollowedPubkeys();
    if (follows.length === 0) {
      this.gridEl.innerHTML =
        '<p class="scc-article-feed__empty">Follow users to see their recipes here.</p>';
      return;
    }

    this.gridEl.innerHTML = '<p class="pulsate">Loading recipes...</p>';

    const recipes = await this.fetchRecipes(follows);
    this.gridEl.innerHTML = '';

    diagLog('system', 'Recipe feed loaded', {
      recipes: recipes.length,
      follows: follows.length,
    });

    if (recipes.length === 0) {
      this.gridEl.innerHTML =
        '<p class="scc-article-feed__empty">No recipes from your follows yet.</p>';
      return;
    }

    for (const event of recipes) {
      this.gridEl.appendChild(this.createCard(event));
    }
    this.infiniteScroll.observe(this.gridEl);

    if (recipes.length < BATCH_SIZE) {
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
      const recipes = await this.fetchRecipes(follows);

      if (recipes.length === 0) {
        this.hasMore = false;
        this.infiniteScroll.disconnect();
      } else {
        for (const event of recipes) {
          this.gridEl.appendChild(this.createCard(event));
        }
        if (recipes.length < BATCH_SIZE) {
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

  private async fetchRecipes(authors: string[]): Promise<NostrEvent[]> {
    const allEvents: NostrEvent[] = [];

    for (let i = 0; i < authors.length; i += AUTHOR_BATCH_SIZE) {
      const batch = authors.slice(i, i + AUTHOR_BATCH_SIZE);
      const events = await fetchEvents(
        [
          {
            kinds: [30023],
            authors: batch,
            '#t': [RECIPE_DISCOVERY_TAG],
            until: this.oldestTimestamp,
            limit: BATCH_SIZE + 10,
          },
        ],
        8000
      );
      allEvents.push(...events);
    }

    // Newest version per coordinate, then unseen ones sorted newest first.
    for (const event of allEvents) {
      if (!event.id || this.seenIds.has(event.id)) continue;
      const coord = `${event.pubkey}:${getTag(event.tags, 'd')}`;
      const prev = this.newestByCoord.get(coord);
      if (!prev || (event.created_at ?? 0) > (prev.created_at ?? 0)) {
        this.newestByCoord.set(coord, event);
      }
    }

    const sorted = [...this.newestByCoord.values()]
      .filter(e => e.id && !this.seenIds.has(e.id))
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

    const items = sorted.slice(0, BATCH_SIZE);
    for (const event of items) this.seenIds.add(event.id!);

    if (items.length > 0) {
      const last = items[items.length - 1]!;
      this.oldestTimestamp = (last.created_at ?? this.oldestTimestamp) - 1;
    }

    return items;
  }

  private createCard(event: NostrEvent): HTMLElement {
    const dTag = getTag(event.tags, 'd');
    const title = getTag(event.tags, 'title') || 'Untitled recipe';
    const image = getTag(event.tags, 'image');
    const naddr = encodeNaddr({
      kind: 30023,
      pubkey: event.pubkey,
      identifier: dTag,
      relays: [],
    });

    const card = document.createElement('article');
    card.className = 'nn-card scc-article-card';
    card.innerHTML = `
      ${
        image
          ? `<div class="nn-card__media"><img src="${escapeHtmlAttr(image)}" alt="" loading="lazy" /></div>`
          : ''
      }
      <div class="nn-card__content">
        <h3 class="nn-card__title">${escapeHtml(title)}</h3>
        <div class="nn-card__meta">
          <span class="author user-mention" data-pubkey="${event.pubkey}">
            <a href="/profile/${hexToNpub(event.pubkey)}" class="mention-link" data-profile-pubkey="${event.pubkey}">
              <img class="profile-pic profile-pic--mini" src="" alt="" width="18" height="18" loading="lazy" decoding="async" />...</a>
          </span>
          <span>${formatTimestamp(event.created_at ?? 0)}</span>
        </div>
      </div>
    `;

    // Async avatar fill — same pipeline as the scc article feed.
    void this.loadAuthorInfo(card, event.pubkey);

    card.style.cursor = 'pointer';
    card.addEventListener('click', (e: MouseEvent) => {
      // Let the author handle work natively.
      if ((e.target as HTMLElement).closest('a')) return;
      this.router.navigate(`/article/${naddr}`);
    });

    return card;
  }

  private async loadAuthorInfo(
    card: HTMLElement,
    pubkey: string
  ): Promise<void> {
    await loadAuthorMention(card, pubkey);
  }
}
