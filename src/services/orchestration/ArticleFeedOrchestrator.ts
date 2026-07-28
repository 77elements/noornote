/**
 * ArticleFeedOrchestrator - Long-form Article Feed Management
 * Handles fetching and pagination of kind 30023 (NIP-23) articles
 *
 * Separate, self-contained orchestrator for article timeline feature.
 * Can be easily disabled by removing route and sidebar entry.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { RelayConfig } from '../RelayConfig';
import { SystemLogger } from '../SystemLogger';
import { LongFormOrchestrator } from './LongFormOrchestrator';
import { getTag } from '../../helpers/tagUtils';
import { LRUCache, getCacheSize } from '../../helpers/LRUCache';
import { diagLog } from '../DiagnosticLogger';

export interface ArticleFeedResult {
  articles: NostrEvent[];
  hasMore: boolean;
}

export class ArticleFeedOrchestrator extends Orchestrator {
  private static instance: ArticleFeedOrchestrator;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;

  /** Cache of fetched articles (LRU-bounded) */
  private articleCache = new LRUCache<NostrEvent>(getCacheSize(200, 100, 50));

  /** Oldest timestamp for pagination */
  private oldestTimestamp: number = Math.floor(Date.now() / 1000);

  /** Page size for loading */
  private readonly PAGE_SIZE = 20;

  private constructor() {
    super('ArticleFeedOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.systemLogger.info('ArticleFeedOrchestrator', 'Article Feed Orchestrator initialized');
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

  /**
   * Load initial articles
   */
  public async loadInitial(): Promise<ArticleFeedResult> {
    this.reset();
    return this.fetchArticles();
  }

  /**
   * Load more articles (pagination)
   */
  public async loadMore(): Promise<ArticleFeedResult> {
    return this.fetchArticles();
  }

  /**
   * Reset state for fresh load
   */
  public reset(): void {
    this.oldestTimestamp = Math.floor(Date.now() / 1000);
    this.articleCache.clear();
  }

  /**
   * Fetch articles from relays
   */
  private async fetchArticles(): Promise<ArticleFeedResult> {
    try {
      const relays = this.relayConfig.getReadRelays();

      if (relays.length === 0) {
        this.systemLogger.warn('ArticleFeedOrchestrator', 'No read relays configured');
        return { articles: [], hasMore: false };
      }

      // Fetch kind 30023 (long-form articles)
      const filter = {
        kinds: [30023],
        until: this.oldestTimestamp,
        limit: this.PAGE_SIZE + 5 // Fetch a few extra to check hasMore
      };

      this.systemLogger.info(
        'ArticleFeedOrchestrator',
        `Fetching articles until ${new Date(this.oldestTimestamp * 1000).toISOString()}`
      );

      const events = await this.transport.fetch(relays, [filter], 8000, false, 'ArticleFeedOrch');

      // Drop articles without a cover image — spam articles are almost always image-less,
      // while real long-form content carries an `image` tag, `imeta`, or a markdown/html <img>.
      const withCover = events.filter(e => this.hasCoverImage(e));
      const removed = events.length - withCover.length;
      if (removed > 0) {
        diagLog('system', `Cover filter: removed ${removed} of ${events.length} articles (no cover image)`, {});
        this.systemLogger.info('Articles', `Filtered ${removed} articles without cover image`);
      }

      // Deduplicate by addressable identifier (pubkey + d-tag)
      const uniqueArticles = this.deduplicateArticles(withCover);

      // Sort by created_at descending
      uniqueArticles.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

      // Check if we have more
      const hasMore = uniqueArticles.length > this.PAGE_SIZE;
      const articlesToReturn = uniqueArticles.slice(0, this.PAGE_SIZE);

      // Update oldest timestamp for next page
      const oldest = articlesToReturn[articlesToReturn.length - 1];
      if (oldest) {
        this.oldestTimestamp = (oldest.created_at || 0) - 1;
      }

      // Cache articles
      articlesToReturn.forEach(article => {
        const key = this.getArticleKey(article);
        this.articleCache.set(key, article);
      });

      this.systemLogger.info(
        'ArticleFeedOrchestrator',
        `Fetched ${articlesToReturn.length} articles, hasMore: ${hasMore}`
      );

      return {
        articles: articlesToReturn,
        hasMore
      };
    } catch (error) {
      this.systemLogger.error('ArticleFeedOrchestrator', 'Failed to fetch articles:', error);
      return { articles: [], hasMore: false };
    }
  }

  /**
   * Deduplicate articles by addressable identifier
   * For addressable events, keep the most recent version
   */
  private deduplicateArticles(events: NostrEvent[]): NostrEvent[] {
    const articleMap = new Map<string, NostrEvent>();

    for (const event of events) {
      const key = this.getArticleKey(event);
      const existing = articleMap.get(key);

      if (!existing || (event.created_at || 0) > (existing.created_at || 0)) {
        articleMap.set(key, event);
      }
    }

    return Array.from(articleMap.values());
  }

  /**
   * Get unique key for article (pubkey + d-tag)
   */
  private getArticleKey(event: NostrEvent): string {
    const dTag = getTag(event.tags, 'd');
    return `${event.pubkey}:${dTag}`;
  }

  /**
   * Check if article has a cover image (NIP-23 `image` tag only — the canonical cover).
   * Inline `imeta` attachments and markdown images in content do NOT count:
   * spammers use those for embeds without setting a proper cover, and the article
   * card renderer doesn't surface them as a cover either.
   */
  private hasCoverImage(event: NostrEvent): boolean {
    return !!getTag(event.tags, 'image')?.trim();
  }

  /**
   * Extract metadata from article event
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
