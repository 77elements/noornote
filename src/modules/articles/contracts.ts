import type { ArticleOptions } from '../../services/ArticleService';
import type { ArticleMetadata } from '../../services/orchestration/LongFormOrchestrator';
import type { ArticleFeedResult, ArticleFeedFetchOptions, ArticleFeedFetchResult } from '../../services/orchestration/ArticleFeedOrchestrator';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export type { ArticleOptions, ArticleMetadata, ArticleFeedResult, ArticleFeedFetchOptions, ArticleFeedFetchResult };

export interface ArticlesModuleApi {
  publishArticle(options: ArticleOptions): Promise<string | null>;
  saveDraft(options: ArticleOptions): Promise<string | null>;
  generateSlug(title: string): string;
  generateIdentifier(title?: string): string;
  fetchAddressableEvent(naddrRef: string): Promise<NostrEvent | null>;
  extractArticleMetadata(event: NostrEvent): ArticleMetadata;

  // ArticleNotificationService
  isSubscribedToArticleNotifications(pubkey: string): boolean;
  toggleArticleNotifications(pubkey: string): boolean;
  /** Pubkeys the user has explicitly subscribed to article alerts for,
   *  regardless of whether they're followed. Used by the article feed to
   *  surface articles from these authors at every FOAF degree. */
  getSubscribedArticlePubkeys(): string[];

  // ArticleFeedOrchestrator — stateless pipeline (formerly direct static
  // calls; routed through the module API so consumers don't import the
  // orchestrator class directly, per /build-validate Step 22).
  /** Stateless fetch+dedup+sort for one page of follows' articles. */
  fetchFollowingArticles(opts: ArticleFeedFetchOptions): Promise<ArticleFeedFetchResult>;
  /** Stable addressable id (pubkey:d-tag) for an article event. */
  getArticleAddressableId(event: NostrEvent): string;
  /** Alias for extractArticleMetadata — kept for the legacy module-API name. */
  extractArticleFeedMetadata(event: NostrEvent): ArticleMetadata;
}
