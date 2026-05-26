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

  // ArticleFeedOrchestrator
  loadInitialArticleFeed(): Promise<ArticleFeedResult>;
  loadMoreArticleFeed(): Promise<ArticleFeedResult>;
  extractArticleFeedMetadata(event: NostrEvent): ArticleMetadata;
}
