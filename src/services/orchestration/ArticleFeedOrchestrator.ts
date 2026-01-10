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
import { SystemLogger } from '../../components/system/SystemLogger';
import { LongFormOrchestrator } from './LongFormOrchestrator';

export interface ArticleFeedResult {
  articles: NostrEvent[];
  hasMore: boolean;
}

export class ArticleFeedOrchestrator extends Orchestrator {
  private static instance: ArticleFeedOrchestrator;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;

  /** Cache of fetched articles */
  private articleCache: Map<string, NostrEvent> = new Map();

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

      const events = await this.transport.fetch(relays, [filter], 8000);

      // Deduplicate by addressable identifier (pubkey + d-tag)
      const uniqueArticles = this.deduplicateArticles(events);

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
    const dTag = event.tags?.find(t => t[0] === 'd')?.[1] || '';
    return `${event.pubkey}:${dTag}`;
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
