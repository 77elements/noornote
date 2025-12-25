/**
 * HashtagNotificationService
 * Manages hashtag notification subscriptions for the current user
 *
 * Features:
 * - Subscribe/unsubscribe to hashtag notifications
 * - Poll for new posts with subscribed hashtags (1x per 5 minutes)
 * - Store subscriptions and last-seen timestamps in PerAccountLocalStorage
 * - ONE notification per hashtag (not per post)
 */

import { SearchOrchestrator } from './orchestration/SearchOrchestrator';
import { EventBus } from './EventBus';
import { SystemLogger } from '../components/system/SystemLogger';
import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds

interface StorageData {
  subscriptions: {
    [hashtag: string]: {
      subscribedAt: number;
      lastSeenTimestamp: number; // Unix timestamp of last seen post
    };
  };
}

export class HashtagNotificationService {
  private static instance: HashtagNotificationService;
  private searchOrchestrator: SearchOrchestrator;
  private eventBus: EventBus;
  private systemLogger: SystemLogger;
  private storage: PerAccountLocalStorage;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private isPollingStarted = false;

  private constructor() {
    this.searchOrchestrator = SearchOrchestrator.getInstance();
    this.eventBus = EventBus.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.storage = PerAccountLocalStorage.getInstance();
  }

  public static getInstance(): HashtagNotificationService {
    if (!HashtagNotificationService.instance) {
      HashtagNotificationService.instance = new HashtagNotificationService();
    }
    return HashtagNotificationService.instance;
  }

  /**
   * Check if hashtag is subscribed
   */
  public isSubscribed(hashtag: string): boolean {
    const data = this.loadData();
    return hashtag in data.subscriptions;
  }

  /**
   * Subscribe to hashtag notifications
   */
  public subscribe(hashtag: string): void {
    const data = this.loadData();

    if (!(hashtag in data.subscriptions)) {
      data.subscriptions[hashtag] = {
        subscribedAt: Date.now(),
        lastSeenTimestamp: Math.floor(Date.now() / 1000)
      };
      this.saveData(data);
      this.eventBus.emit('hashtag-subscription:updated', { hashtag, subscribed: true });
    }
  }

  /**
   * Unsubscribe from hashtag notifications
   */
  public unsubscribe(hashtag: string): void {
    const data = this.loadData();

    if (hashtag in data.subscriptions) {
      delete data.subscriptions[hashtag];
      this.saveData(data);
      this.eventBus.emit('hashtag-subscription:updated', { hashtag, subscribed: false });
    }
  }

  /**
   * Toggle subscription status
   */
  public toggle(hashtag: string): boolean {
    if (this.isSubscribed(hashtag)) {
      this.unsubscribe(hashtag);
      return false;
    } else {
      this.subscribe(hashtag);
      return true;
    }
  }

  /**
   * Get all subscribed hashtags
   */
  public getSubscribedHashtags(): string[] {
    const data = this.loadData();
    return Object.keys(data.subscriptions);
  }

  /**
   * Start polling for new posts
   */
  public startPolling(): void {
    // Guard against race condition: check flag first
    if (this.isPollingStarted) return;
    this.isPollingStarted = true;

    // Initial check after 1 minute
    setTimeout(() => {
      this.checkForNewPosts();
    }, 60 * 1000);

    // Poll every 5 minutes
    this.pollInterval = setInterval(() => {
      this.checkForNewPosts();
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
   * Check for new posts from subscribed hashtags
   */
  public async checkForNewPosts(): Promise<void> {
    const data = this.loadData();
    const subscribed = Object.keys(data.subscriptions);

    if (subscribed.length === 0) {
      return;
    }

    // System log: Polling start
    this.systemLogger.info('HashtagNotificationService', `🔍 Polling ${subscribed.length} subscribed hashtags`);

    for (const hashtag of subscribed) {
      const subscription = data.subscriptions[hashtag];

      try {
        const results = await this.searchOrchestrator.search({
          query: `#${hashtag}`,
          limit: 10
        });

        // Filter: only posts newer than lastSeenTimestamp
        const newPosts = results.filter(e => e.created_at > subscription.lastSeenTimestamp);

        if (newPosts.length > 0) {
          // System log: New posts found
          this.systemLogger.info('HashtagNotificationService', `✨ Found ${newPosts.length} new posts for #${hashtag}`);

          // Update last seen
          subscription.lastSeenTimestamp = Math.max(...newPosts.map(e => e.created_at));
          this.saveData(data);

          // Emit ONE notification per hashtag (not per post)
          this.eventBus.emit('hashtag:new-posts', {
            hashtag,
            count: newPosts.length,
            latestEvent: newPosts[0] // Most recent post for preview
          });
        }
      } catch (error) {
        this.systemLogger.error('HashtagNotificationService', `Failed to check #${hashtag}:`, error);
      }
    }

    // System log: Polling complete
    this.systemLogger.info('HashtagNotificationService', `✅ Polling complete`);
  }

  /**
   * Load data from PerAccountLocalStorage
   */
  private loadData(): StorageData {
    return this.storage.get<StorageData>(StorageKeys.HASHTAG_SUBSCRIPTIONS, { subscriptions: {} });
  }

  /**
   * Save data to PerAccountLocalStorage
   */
  private saveData(data: StorageData): void {
    this.storage.set(StorageKeys.HASHTAG_SUBSCRIPTIONS, data);
  }
}
