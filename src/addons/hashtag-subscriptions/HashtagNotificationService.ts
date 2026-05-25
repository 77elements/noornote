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

import { ModuleLoader } from '../../core/ModuleLoader';
import type { SearchModuleApi } from '../../modules/search/contracts';
import { EventBus } from '../../services/EventBus';
import { SystemLogger } from '../../services/SystemLogger';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
import { NoteService } from '../../services/NoteService';

const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds

export interface HashtagSubscription {
  subscribedAt: number;
  lastSeenTimestamp: number; // Unix timestamp of last seen post
  includeWithoutHash: boolean; // Also search for term without # prefix
}

interface StorageData {
  subscriptions: {
    [hashtag: string]: HashtagSubscription;
  };
}

export class HashtagNotificationService {
  private static instance: HashtagNotificationService;
  private searchApi: SearchModuleApi | null;
  private eventBus: EventBus;
  private systemLogger: SystemLogger;
  private storage: PerAccountLocalStorage;
  private noteService: NoteService;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private initialPollTimeout: ReturnType<typeof setTimeout> | null = null;
  private isPollingStarted = false;

  private constructor() {
    this.searchApi = ModuleLoader.getInstance().getApi<SearchModuleApi>('search');
    this.eventBus = EventBus.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.storage = PerAccountLocalStorage.getInstance();
    this.noteService = NoteService.getInstance();
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
        lastSeenTimestamp: Math.floor(Date.now() / 1000),
        includeWithoutHash: false
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
   * Get subscription details for a hashtag
   */
  public getSubscription(hashtag: string): HashtagSubscription | null {
    const data = this.loadData();
    return data.subscriptions[hashtag] || null;
  }

  /**
   * Get all subscriptions with details
   */
  public getAllSubscriptions(): { hashtag: string; subscription: HashtagSubscription }[] {
    const data = this.loadData();
    return Object.entries(data.subscriptions).map(([hashtag, subscription]) => ({
      hashtag,
      subscription: {
        ...subscription,
        // Ensure includeWithoutHash has a default for old subscriptions
        includeWithoutHash: subscription.includeWithoutHash ?? false
      }
    }));
  }

  /**
   * Set includeWithoutHash flag for a subscription
   */
  public setIncludeWithoutHash(hashtag: string, include: boolean): void {
    const data = this.loadData();
    const subscription = data.subscriptions[hashtag];

    if (subscription) {
      subscription.includeWithoutHash = include;
      this.saveData(data);
      this.eventBus.emit('hashtag-subscription:updated', { hashtag, includeWithoutHash: include });
    }
  }

  /**
   * Start polling for new posts
   */
  public startPolling(): void {
    // Guard against race condition: check flag first
    if (this.isPollingStarted) return;
    this.isPollingStarted = true;

    // Initial check after 1 minute — tracked so destroy() can cancel it
    this.initialPollTimeout = setTimeout(() => {
      this.initialPollTimeout = null;
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
    if (this.initialPollTimeout) {
      clearTimeout(this.initialPollTimeout);
      this.initialPollTimeout = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Tear down the service. Called by the AddonLoader runtime on toggle-OFF,
   * logout, or account switch.
   *
   * Destroy contract:
   *   - stopPolling() clears both timers
   *   - releases the static singleton so the next getInstance() returns a
   *     fresh instance (important on account switch — subscriptions are
   *     per-account, so a stale instance would reference the old account's
   *     data even if the interval is stopped)
   */
  public destroy(): void {
    this.stopPolling();
    if (HashtagNotificationService.instance === this) {
      // @ts-expect-error intentional reset of private static
      HashtagNotificationService.instance = undefined;
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
      if (!subscription) continue;

      // Ensure includeWithoutHash has a default for old subscriptions
      const includeWithoutHash = subscription.includeWithoutHash ?? false;

      try {
        // Search for #hashtag
        const hashtagResults = await this.searchApi?.search({
          query: `#${hashtag}`,
          limit: 10
        }) ?? [];

        let allResults = [...hashtagResults];

        if (includeWithoutHash) {
          const termResults = await this.searchApi?.search({
            query: hashtag,
            limit: 10
          }) ?? [];

          const seenIds = new Set(allResults.map((e: any) => e.id));
          for (const event of termResults) {
            if (!seenIds.has(event.id)) {
              allResults.push(event);
              seenIds.add(event.id);
            }
          }
        }

        // Client-side verification: search relays return fuzzy matches,
        // so verify the hashtag actually appears in #t tags or content text
        const hashtagLower = hashtag.toLowerCase();
        allResults = allResults.filter(event => {
          // Check #t tags (canonical hashtag location per NIP-01)
          const hasTag = event.tags?.some(
            t => t[0] === 't' && t[1]?.toLowerCase() === hashtagLower
          );
          if (hasTag) return true;

          // Check content text (case-insensitive)
          const content = event.content?.toLowerCase() || '';
          if (content.includes(`#${hashtagLower}`)) return true;
          if (includeWithoutHash && content.includes(hashtagLower)) return true;

          return false;
        });

        // Register verified notes in NoteService for cache reuse
        this.noteService.registerNotes(allResults);

        // Filter: only posts newer than lastSeenTimestamp
        const newPosts = allResults.filter(e => e.created_at > subscription.lastSeenTimestamp);

        if (newPosts.length > 0) {
          // System log: New posts found
          const searchType = includeWithoutHash ? `#${hashtag} + "${hashtag}"` : `#${hashtag}`;
          this.systemLogger.info('HashtagNotificationService', `Found ${newPosts.length} new posts for ${searchType}`);

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
