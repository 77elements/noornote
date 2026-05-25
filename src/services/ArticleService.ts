/**
 * ArticleService - Long-form Content Publishing Service
 * Handles creation and publishing of Kind 30023 (articles) and Kind 30024 (drafts)
 *
 * NIP-23: https://github.com/nostr-protocol/nips/blob/master/23.md
 * - Kind 30023: Published long-form content (addressable/replaceable)
 * - Kind 30024: Draft long-form content (same structure)
 */

import { AuthService } from './AuthService';
import { NostrTransport } from './transport/NostrTransport';
import { SystemLogger } from './SystemLogger';
import { ErrorService } from './ErrorService';
import { ToastService } from './ToastService';
import { encodeNaddr } from './NostrToolsAdapter';

export interface ArticleOptions {
  /** Article title */
  title: string;
  /** Article content (Markdown) */
  content: string;
  /** Unique identifier (d-tag / slug) */
  identifier: string;
  /** Brief summary/description */
  summary?: string;
  /** Cover/banner image URL */
  image?: string;
  /** Topic tags (t-tags) */
  topics?: string[];
  /** Publication timestamp (defaults to now) */
  publishedAt?: number;
  /** Target relays to publish to */
  relays: string[];
}

export class ArticleService {
  private static instance: ArticleService;
  private authService: AuthService;
  private transport: NostrTransport;
  private systemLogger: SystemLogger;

  private constructor() {
    this.authService = AuthService.getInstance();
    this.transport = NostrTransport.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): ArticleService {
    if (!ArticleService.instance) {
      ArticleService.instance = new ArticleService();
    }
    return ArticleService.instance;
  }

  /**
   * Publish an article (Kind 30023)
   */
  public async publishArticle(options: ArticleOptions): Promise<string | null> {
    return this.createArticleEvent(options, false);
  }

  /**
   * Save a draft (Kind 30024)
   */
  public async saveDraft(options: ArticleOptions): Promise<string | null> {
    return this.createArticleEvent(options, true);
  }

  /**
   * Create and publish article/draft event
   * @returns naddr on success, null on failure
   */
  private async createArticleEvent(
    options: ArticleOptions,
    isDraft: boolean
  ): Promise<string | null> {
    const { title, content, identifier, summary, image, topics, publishedAt, relays } = options;

    // Validate authentication
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.systemLogger.error('ArticleService', 'Cannot create article: User not authenticated');
      return null;
    }

    // Validate required fields
    if (!title || title.trim().length === 0) {
      this.systemLogger.error('ArticleService', 'Cannot create article: Title is empty');
      ToastService.show('Title is required', 'error');
      return null;
    }

    if (!content || content.trim().length === 0) {
      this.systemLogger.error('ArticleService', 'Cannot create article: Content is empty');
      ToastService.show('Content is required', 'error');
      return null;
    }

    if (!identifier || identifier.trim().length === 0) {
      this.systemLogger.error('ArticleService', 'Cannot create article: Identifier is empty');
      ToastService.show('Identifier/slug is required', 'error');
      return null;
    }

    if (!relays || relays.length === 0) {
      this.systemLogger.error('ArticleService', 'Cannot create article: No relays specified');
      ToastService.show('Please select at least one relay', 'error');
      return null;
    }

    try {
      const kind = isDraft ? 30024 : 30023;
      const now = Math.floor(Date.now() / 1000);

      // Build tags array
      const tags: string[][] = [
        ['d', identifier.trim()],
        ['title', title.trim()]
      ];

      // Add optional tags
      if (summary && summary.trim().length > 0) {
        tags.push(['summary', summary.trim()]);
      }

      if (image && image.trim().length > 0) {
        tags.push(['image', image.trim()]);
      }

      // Add published_at tag
      tags.push(['published_at', String(publishedAt || now)]);

      // Add topic tags
      if (topics && topics.length > 0) {
        topics.forEach(topic => {
          const trimmed = topic.trim();
          if (trimmed.length > 0) {
            tags.push(['t', trimmed.toLowerCase()]);
          }
        });
      }

      // Build unsigned event
      const unsignedEvent = {
        kind,
        created_at: now,
        tags,
        content: content.trim(),
        pubkey: currentUser.pubkey
      };

      // Sign event
      const signedEvent = await this.authService.signEvent(unsignedEvent);

      if (!signedEvent) {
        this.systemLogger.error('ArticleService', 'Failed to sign article event');
        return null;
      }

      // Publish to specified relays
      await this.transport.publish(relays, signedEvent);

      const eventType = isDraft ? 'Draft' : 'Article';
      this.systemLogger.info(
        'ArticleService',
        `${eventType} published to ${relays.length} relay(s): ${signedEvent.id?.slice(0, 8)}...`
      );

      // Show success toast
      ToastService.show(
        isDraft ? 'Draft saved successfully!' : 'Article published successfully!',
        'success'
      );

      // Return naddr for navigation
      const naddr = encodeNaddr({
        kind,
        pubkey: currentUser.pubkey,
        identifier: identifier.trim(),
        relays: relays.slice(0, 2) // Include up to 2 relay hints
      });

      return naddr;
    } catch (error) {
      ErrorService.handle(
        error,
        'ArticleService.createArticleEvent',
        true,
        isDraft ? 'Failed to save draft. Please try again.' : 'Failed to publish article. Please try again.'
      );
      return null;
    }
  }

  /**
   * Generate a URL-friendly slug from title
   */
  public static generateSlug(title: string): string {
    return title
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '') // Remove special characters
      .replace(/\s+/g, '-')     // Replace spaces with hyphens
      .replace(/-+/g, '-')      // Replace multiple hyphens with single
      .slice(0, 80);            // Limit length
  }

  /**
   * Generate a unique identifier (slug + timestamp suffix)
   */
  public static generateIdentifier(title?: string): string {
    const timestamp = Date.now().toString(36); // Base36 timestamp for brevity

    if (title && title.trim().length > 0) {
      const slug = this.generateSlug(title);
      return slug ? `${slug}-${timestamp}` : timestamp;
    }

    return timestamp;
  }
}
