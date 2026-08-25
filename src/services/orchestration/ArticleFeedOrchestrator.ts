/**
 * ArticleFeedOrchestrator - Long-form Article Feed Management
 * Handles fetching and pagination of kind 30023 (NIP-23) articles.
 *
 * Single source of truth for "fetch + dedup + sort" of follows' articles.
 * Two consumer surfaces share this orchestrator:
 *   • `ArticleTimeline` (main /articles view) → instance API (loadInitial/loadMore)
 *   • `SccArticleFeed` (SCC "Newest Articles" tab) → static `fetchFollowingArticles`
 *
 * Both surfaces own their own pagination cursor + seen-set; the orchestrator
 * owns the relay-fetch + dedup-by-addressable-id + sort-desc pipeline. This
 * eliminates the duplicated fetch logic that previously lived inside
 * `SccArticleFeed` (MainLayout secondary column).
 *
 * Feed source: only articles authored by the current user's follows
 * (`{kinds:[30023], authors: followingPubkeys}`). The previous global
 * firehose mode was the root cause of the spam problem and has been removed.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { SystemLogger } from '../SystemLogger';
import { LongFormOrchestrator } from './LongFormOrchestrator';
import { getTag } from '../../helpers/tagUtils';
import { LRUCache, getCacheSize } from '../../helpers/LRUCache';
import { getAllFollowedPubkeys } from '../../lists/follows';
import { fetchEvents } from '../../lists/relays';

/**
 * Authors per kind:30023 fetch. Some relays cap `authors` list length;
 * batching keeps us well under any reasonable cap and matches the proven
 * SccArticleFeed behaviour. Exported for tests.
 */
export const AUTHOR_FETCH_BATCH = 150;

/**
 * How many author-batches to fire concurrently. Bounded to be polite to
 * relays — high concurrency on large FOAF sets (hundreds of batches) is
 * exactly the kind of burst that gets a client rate-limited or blocked.
 * 3 concurrent × 150 authors = 450 authors in flight at once, well below
 * typical relay tolerance thresholds. Exported for tests.
 */
export const AUTHOR_FETCH_CONCURRENCY = 3;

/**
 * Per-batch relay fetch timeout. SccArticleFeed used 8000; keep it.
 */
const FETCH_TIMEOUT_MS = 8000;

export interface ArticleFeedResult {
  articles: NostrEvent[];
  hasMore: boolean;
}

/**
 * Options for the stateless fetch+dedup+sort pipeline.
 * Callers own their own `until` cursor and `excludeIds` set; the orchestrator
 * does not retain any per-caller state across calls.
 */
export interface ArticleFeedFetchOptions {
  /** Pubkeys whose kind:30023 articles to fetch. */
  authors: string[];
  /** Pagination cursor: only return articles with `created_at < until`. */
  until: number;
  /** Target page size (the pipeline fetches a few extra for hasMore detection). */
  limit: number;
  /** Addressable IDs (pubkey:d-tag) the caller has already rendered.
   *  Used to dedupe across pages — pass the same set you update with each batch. */
  excludeIds?: Set<string>;
}

/**
 * Result of the stateless pipeline. Callers update their cursor + seen-set
 * from `articles` before the next call.
 */
export interface ArticleFeedFetchResult {
  articles: NostrEvent[];
  /** Next `until` cursor — oldest article's `created_at` minus 1, or unchanged
   *  if no articles were returned. */
  oldestTimestamp: number;
}

export class ArticleFeedOrchestrator extends Orchestrator {
  private static instance: ArticleFeedOrchestrator;
  private systemLogger: SystemLogger;

  /** Cache of fetched articles (LRU-bounded). Shared across consumer surfaces. */
  private articleCache = new LRUCache<NostrEvent>(getCacheSize(200, 100, 50));

  // ── Singleton instance state (used by ArticleTimeline main view) ─────────
  private oldestTimestamp: number = Math.floor(Date.now() / 1000);
  private readonly seenIds = new Set<string>();
  private readonly PAGE_SIZE = 20;

  private constructor() {
    super('ArticleFeedOrchestrator');
    this.systemLogger = SystemLogger.getInstance();
    this.systemLogger.info(
      'ArticleFeedOrchestrator',
      'Article Feed Orchestrator initialized'
    );
  }

  public static getInstance(): ArticleFeedOrchestrator {
    if (!ArticleFeedOrchestrator.instance) {
      ArticleFeedOrchestrator.instance = new ArticleFeedOrchestrator();
    }
    return ArticleFeedOrchestrator.instance;
  }

  // Abstract method stubs (not using router pattern)
  public onui(_data: unknown): void {}
  public onopen(_relay: string): void {}
  public onmessage(_relay: string, _event: NostrEvent): void {}
  public onerror(_relay: string, _error: Error): void {}
  public onclose(_relay: string): void {}

  // ─────────────────────────────────────────────────────────────────────────
  // Instance API (used by ArticleTimeline main view)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Load initial articles. Resets pagination cursor and seen-set.
   */
  public async loadInitial(): Promise<ArticleFeedResult> {
    this.oldestTimestamp = Math.floor(Date.now() / 1000);
    this.seenIds.clear();
    return this.loadMore();
  }

  /**
   * Load the next page of articles.
   */
  public async loadMore(): Promise<ArticleFeedResult> {
    const authors = getAllFollowedPubkeys();
    if (authors.length === 0) {
      this.systemLogger.info(
        'ArticleFeedOrchestrator',
        'No follows — feed empty'
      );
      return { articles: [], hasMore: false };
    }

    const result = await ArticleFeedOrchestrator.fetchFollowingArticles({
      authors,
      until: this.oldestTimestamp,
      limit: this.PAGE_SIZE,
      excludeIds: this.seenIds,
    });

    for (const article of result.articles) {
      this.seenIds.add(ArticleFeedOrchestrator.getAddressableId(article));
      this.articleCache.set(
        ArticleFeedOrchestrator.getAddressableId(article),
        article
      );
    }
    this.oldestTimestamp = result.oldestTimestamp;

    this.systemLogger.info(
      'ArticleFeedOrchestrator',
      `Fetched ${result.articles.length} articles, hasMore: ${result.articles.length >= this.PAGE_SIZE}`
    );

    return {
      articles: result.articles,
      hasMore: result.articles.length >= this.PAGE_SIZE,
    };
  }

  /**
   * Reset instance state. Called when the consumer view is torn down and wants
   * a fresh feed on next mount.
   */
  public reset(): void {
    this.oldestTimestamp = Math.floor(Date.now() / 1000);
    this.seenIds.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stateless pipeline (shared with SccArticleFeed and any future consumer)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetch one page of articles authored by `opts.authors`.
   *
   * Pipeline:
   *   1. Batch `authors` into chunks of ${AUTHOR_FETCH_BATCH} and query
   *      `{kinds:[30023], authors: batch, until, limit}` per batch in
   *      sequence. Batching avoids relay-side author-list caps.
   *   2. Deduplicate by addressable id (`pubkey:d-tag`), keeping the newest
   *      version per id (handles replaceable article updates).
   *   3. Exclude any id in `opts.excludeIds` (already shown to the caller).
   *   4. Sort by `created_at` descending.
   *   5. Return the first `opts.limit` items plus the new pagination cursor.
   *
   * Pure function — no orchestrator state is read or written.
   */
  public static async fetchFollowingArticles(
    opts: ArticleFeedFetchOptions
  ): Promise<ArticleFeedFetchResult> {
    const { authors, until, limit, excludeIds } = opts;

    if (authors.length === 0 || limit <= 0) {
      return { articles: [], oldestTimestamp: until };
    }

    // Fetch a few extra to detect hasMore without an extra round-trip.
    const fetchLimit = limit + 5;
    const allEvents: NostrEvent[] = [];

    // Slice authors into batches and run them with bounded concurrency.
    // Sequential iteration would be O(N batches × round-trip); with 28k
    // FOAF degree-2 pubkeys that's ~190 batches and several minutes wait.
    const batches: string[][] = [];
    for (let i = 0; i < authors.length; i += AUTHOR_FETCH_BATCH) {
      batches.push(authors.slice(i, i + AUTHOR_FETCH_BATCH));
    }

    for (let i = 0; i < batches.length; i += AUTHOR_FETCH_CONCURRENCY) {
      const window = batches.slice(i, i + AUTHOR_FETCH_CONCURRENCY);
      const results = await Promise.allSettled(
        window.map(async batch => {
          try {
            return await fetchEvents(
              [{ kinds: [30023], authors: batch, until, limit: fetchLimit }],
              FETCH_TIMEOUT_MS
            );
          } catch (err) {
            // One failed batch must not poison the whole page — relay hiccups
            // are common. Subsequent batches still deliver what they can.
            SystemLogger.getInstance().warn(
              'ArticleFeedOrchestrator',
              `Batch fetch failed (${batch.length} authors): ${String(err)}`
            );
            return [] as NostrEvent[];
          }
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled') allEvents.push(...r.value);
      }
    }

    if (allEvents.length === 0) {
      return { articles: [], oldestTimestamp: until };
    }

    // Dedup by addressable id, keeping newest version per id.
    const deduped = ArticleFeedOrchestrator.dedupeByAddressableId(allEvents);

    // Drop already-seen (caller-owned seen-set).
    const fresh =
      excludeIds && excludeIds.size > 0
        ? deduped.filter(
            e => !excludeIds.has(ArticleFeedOrchestrator.getAddressableId(e))
          )
        : deduped;

    if (fresh.length === 0) {
      return { articles: [], oldestTimestamp: until };
    }

    // Sort descending by created_at.
    fresh.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    // Page slice.
    const page = fresh.slice(0, limit);
    const oldest = page[page.length - 1];
    const oldestTimestamp = oldest ? (oldest.created_at || until) - 1 : until;

    return { articles: page, oldestTimestamp };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Addressable-id helpers (also used by callers building their seen-set)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Stable identifier for a kind:30023 article (`pubkey:d-tag`).
   * Use this as the key for seen-sets, dedup maps, and LRU caches.
   */
  public static getAddressableId(event: NostrEvent): string {
    const dTag = getTag(event.tags, 'd');
    return `${event.pubkey}:${dTag}`;
  }

  /**
   * Deduplicate by addressable id, keeping the newest version per id.
   */
  private static dedupeByAddressableId(events: NostrEvent[]): NostrEvent[] {
    const best = new Map<string, NostrEvent>();
    for (const e of events) {
      const id = ArticleFeedOrchestrator.getAddressableId(e);
      const existing = best.get(id);
      if (!existing || (e.created_at || 0) > (existing.created_at || 0)) {
        best.set(id, e);
      }
    }
    return [...best.values()];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Metadata extraction (UI consumers)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Extract metadata from article event.
   */
  public static extractMetadata(event: NostrEvent): {
    title: string;
    summary: string;
    image: string;
    identifier: string;
    publishedAt: number;
    topics: string[];
  } {
    return LongFormOrchestrator.extractArticleMetadata(event);
  }
}
