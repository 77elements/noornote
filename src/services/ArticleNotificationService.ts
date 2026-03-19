/**
 * ArticleNotificationService
 * Manages article notification subscriptions for specific users
 *
 * Features:
 * - Subscribe/unsubscribe to article notifications for users
 * - Poll for new articles (1x per hour)
 * - Store subscriptions and last-seen timestamps in localStorage
 */

import { NostrTransport } from './transport/NostrTransport';
import { RelayConfig } from './RelayConfig';
import { EventBus } from './EventBus';
import { encodeNaddr } from './NostrToolsAdapter';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';


const POLL_INTERVAL = 60 * 60 * 1000; // 1 hour in milliseconds

export interface ArticleNotification {
  pubkey: string;
  articleId: string;
  naddr: string;
  title: string;
  createdAt: number;
}

interface StorageData {
  subscriptions: {
    [pubkey: string]: {
      subscribedAt: number;
      lastSeenArticleTimestamp: number;
    };
  };
}

export class ArticleNotificationService {
  private static instance: ArticleNotificationService;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;
  private eventBus: EventBus;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private isPollingStarted = false;

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.eventBus = EventBus.getInstance();
  }

  public static getInstance(): ArticleNotificationService {
    if (!ArticleNotificationService.instance) {
      ArticleNotificationService.instance = new ArticleNotificationService();
    }
    return ArticleNotificationService.instance;
  }

  /**
   * Check if user is subscribed to article notifications
   */
  public isSubscribed(pubkey: string): boolean {
    const data = this.loadData();
    return pubkey in data.subscriptions;
  }

  /**
   * Subscribe to article notifications for a user
   */
  public subscribe(pubkey: string): void {
    const data = this.loadData();

    if (!(pubkey in data.subscriptions)) {
      data.subscriptions[pubkey] = {
        subscribedAt: Date.now(),
        lastSeenArticleTimestamp: Math.floor(Date.now() / 1000)
      };
      this.saveData(data);
      this.eventBus.emit('article-notification:updated', { pubkey, subscribed: true });
    }
  }

  /**
   * Unsubscribe from article notifications for a user
   */
  public unsubscribe(pubkey: string): void {
    const data = this.loadData();

    if (pubkey in data.subscriptions) {
      delete data.subscriptions[pubkey];
      this.saveData(data);
      this.eventBus.emit('article-notification:updated', { pubkey, subscribed: false });
    }
  }

  /**
   * Toggle subscription status
   */
  public toggle(pubkey: string): boolean {
    if (this.isSubscribed(pubkey)) {
      this.unsubscribe(pubkey);
      return false;
    } else {
      this.subscribe(pubkey);
      return true;
    }
  }

  /**
   * Get all subscribed pubkeys
   */
  public getSubscribedPubkeys(): string[] {
    const data = this.loadData();
    return Object.keys(data.subscriptions);
  }

  /**
   * Start polling for new articles
   */
  public startPolling(): void {
    // Guard against race condition: check flag first
    if (this.isPollingStarted) return;
    this.isPollingStarted = true;

    // Initial check
    this.checkForNewArticles();

    // Poll every hour
    this.pollInterval = setInterval(() => {
      this.checkForNewArticles();
    }, POLL_INTERVAL);
  }

  /**
   * Stop polling
   */
  public stopPolling(): void {
    this.isPollingStarted = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Check for new articles from subscribed users
   */
  public async checkForNewArticles(): Promise<ArticleNotification[]> {
    const data = this.loadData();
    const pubkeys = Object.keys(data.subscriptions);

    if (pubkeys.length === 0) {
      return [];
    }

    const relays = this.relayConfig.getReadRelays();
    if (relays.length === 0) {
      return [];
    }

    const newArticles: ArticleNotification[] = [];

    // Fetch articles for all subscribed users
    for (const pubkey of pubkeys) {
      const subscription = data.subscriptions[pubkey];
      if (!subscription) continue;

      try {
        const filter = {
          kinds: [30023],
          authors: [pubkey],
          since: subscription.lastSeenArticleTimestamp + 1,
          limit: 10
        };

        const events = await this.transport.fetch(relays, [filter], 5000, false, 'ArticleNotifService');

        for (const event of events) {
          const metadata = this.extractMetadata(event);

          const naddr = encodeNaddr({
            kind: 30023,
            pubkey: event.pubkey,
            identifier: metadata.identifier,
            relays: []
          });

          newArticles.push({
            pubkey: event.pubkey,
            articleId: event.id || '',
            naddr,
            title: metadata.title,
            createdAt: event.created_at || 0
          });

          // Update last seen timestamp
          if ((event.created_at || 0) > subscription.lastSeenArticleTimestamp) {
            subscription.lastSeenArticleTimestamp = event.created_at || 0;
          }
        }
      } catch (error) {
        console.warn(`Failed to fetch articles for ${pubkey}:`, error);
      }
    }

    // Save updated timestamps
    this.saveData(data);

    // Emit event for each new article
    for (const article of newArticles) {
      this.eventBus.emit('article-notification:new', article);
    }

    return newArticles;
  }

  /**
   * Extract metadata from article event
   */
  private extractMetadata(event: NostrEvent): { title: string; identifier: string } {
    const tags = event.tags || [];
    const title = tags.find(t => t[0] === 'title')?.[1] || 'Untitled';
    const identifier = tags.find(t => t[0] === 'd')?.[1] || '';
    return { title, identifier };
  }

  /**
   * Load data from localStorage
   */
  private loadData(): StorageData {
    return PerAccountLocalStorage.getInstance().get<StorageData>(StorageKeys.ARTICLE_NOTIFICATIONS, { subscriptions: {} });
  }

  /**
   * Save data to per-account storage
   */
  private saveData(data: StorageData): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.ARTICLE_NOTIFICATIONS, data);
  }
}
