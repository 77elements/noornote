import type { ArticleOptions } from '../../services/ArticleService';
import type { ArticleMetadata } from '../../services/orchestration/LongFormOrchestrator';
import type { ArticleFeedResult } from '../../services/orchestration/ArticleFeedOrchestrator';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export type { ArticleOptions, ArticleMetadata, ArticleFeedResult };

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

  // ArticleFeedOrchestrator
  loadInitialArticleFeed(): Promise<ArticleFeedResult>;
  loadMoreArticleFeed(): Promise<ArticleFeedResult>;
  extractArticleFeedMetadata(event: NostrEvent): ArticleMetadata;
}
