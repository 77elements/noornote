/**
 * User Service
 * Handles user-related operations like following lists and user metadata
 * Uses NostrTransport for all relay communication
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { NostrTransport } from './transport/NostrTransport';
import { RelayConfig } from './RelayConfig';
import { SystemLogger } from '../components/system/SystemLogger';
import { FollowStorageAdapter } from './sync/adapters/FollowStorageAdapter';
import { AuthService } from './AuthService';

export class UserService {
  private static instance: UserService;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;
  private followAdapter: FollowStorageAdapter;

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.followAdapter = new FollowStorageAdapter();
  }

  public static getInstance(): UserService {
    if (!UserService.instance) {
      UserService.instance = new UserService();
    }
    return UserService.instance;
  }

  /**
   * Get user's following list
   * - For current user: reads from browserItems (localStorage)
   * - For other users: fetches from relays (NDK cached)
   * @param forceRefresh - Skip NDK cache and fetch fresh from relays
   */
  public async getUserFollowing(pubkey: string, forceRefresh: boolean = false): Promise<string[]> {
    const currentUser = AuthService.getInstance().getCurrentUser();
    const isCurrentUser = currentUser?.pubkey === pubkey;

    // For current user: read from browserItems (localStorage)
    if (isCurrentUser) {
      return this.getCurrentUserFollowing();
    }

    // For other users: fetch from relays (NDK cached)
    return this.getOtherUserFollowing(pubkey, forceRefresh);
  }

  /**
   * Get current user's following list from browserItems (localStorage)
   * Falls back to relays if browserItems is empty (account switch or first load)
   */
  private async getCurrentUserFollowing(): Promise<string[]> {
    try {
      // Read from browserItems (localStorage)
      const browserItems = this.followAdapter.getBrowserItems();

      // If browserItems has data, use it
      if (browserItems.length > 0) {
        return browserItems.map(item => item.pubkey);
      }

      // If browserItems is empty, fetch from relays (not files - files are not per-user)
      const currentUser = AuthService.getInstance().getCurrentUser();
      if (currentUser?.pubkey) {
        const relayFollows = await this.getOtherUserFollowing(currentUser.pubkey);
        if (relayFollows.length > 0) {
          // Cache in browserItems for future use
          const items = relayFollows.map(pubkey => ({ id: pubkey, pubkey }));
          this.followAdapter.setBrowserItems(items);
          return relayFollows;
        }
      }

      this.systemLogger.warn('UserService', 'No follow list found, using fallback');
      return this.relayConfig.getFallbackFollowing();
    } catch (error) {
      this.systemLogger.error('UserService', `Error fetching follow list: ${error}`);
      return this.relayConfig.getFallbackFollowing();
    }
  }

  /**
   * Get another user's following list from relays (NDK cached)
   * @param forceRefresh - Skip NDK cache and fetch fresh from relays
   */
  private async getOtherUserFollowing(pubkey: string, forceRefresh: boolean = false): Promise<string[]> {
    try {
      const relays = this.relayConfig.getAggregatorRelays();

      // Fetch kind:3 contact list from relays
      // If forceRefresh, skip NDK cache to get fresh data
      const events = await this.transport.fetch(relays, [{
        authors: [pubkey],
        kinds: [3],
        limit: 1
      }], 5000, forceRefresh);

      if (events.length === 0) {
        return [];
      }

      // Extract pubkeys from p-tags
      const followEvent = events[0];
      if (!followEvent) {
        return [];
      }
      const pubkeys = followEvent.tags
        .filter((tag): tag is [string, string, ...string[]] => tag[0] === 'p' && typeof tag[1] === 'string')
        .map(tag => tag[1]);

      return pubkeys;
    } catch (error) {
      this.systemLogger.error('UserService', `Error fetching other user's follow list: ${error}`);
      return [];
    }
  }

  /**
   * Subscribe to user metadata updates
   * Uses NostrTransport for subscriptions
   */
  public async subscribe(
    _subscriptionId: string,
    filter: { authors?: string[]; kinds?: number[]; ids?: string[] },
    callback: (event: NostrEvent) => void
  ): Promise<() => void> {
    const relays = this.transport.getReadRelays();

    // Silent operation
    // this.systemLogger.info('UserService', `Creating subscription: ${_subscriptionId}`);

    const ndkFilter: NDKFilter = {};
    if (filter.authors) ndkFilter.authors = filter.authors;
    if (filter.kinds) ndkFilter.kinds = filter.kinds;
    if (filter.ids) ndkFilter.ids = filter.ids;

    const sub = await this.transport.subscribe(relays, [ndkFilter], {
      onEvent: callback
    });

    // Auto-close after 10 seconds
    setTimeout(() => {
      sub.close();
      // this.systemLogger.info('UserService', `Subscription ${subscriptionId} auto-closed`);
    }, 10000);

    // Return unsubscribe function
    return () => {
      sub.close();
      // this.systemLogger.info('UserService', `Subscription ${subscriptionId} closed`);
    };
  }
}
