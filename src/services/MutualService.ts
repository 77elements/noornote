/**
 * MutualService
 * Checks mutual follow status for users the current user follows
 *
 * @purpose Determine which follows are mutual (they follow back)
 * @used-by MutualSecondaryManager
 *
 * NDK automatically caches Kind:3 events, so repeated checks are fast.
 * Follows are loaded from browserItems (localStorage).
 */

import { AuthService } from './AuthService';
import { FollowVerificationService } from './FollowVerificationService';
import { FollowStorageAdapter, type FollowItem } from '../lists/follows';
import { LRUCache, getCacheSize } from '../helpers/LRUCache';

export interface MutualStatus {
  pubkey: string;
  isMutual: boolean;
}

export interface MutualItemWithStatus extends FollowItem {
  isMutual: boolean;
}

export interface MutualStats {
  totalFollowing: number;
  mutualCount: number;
  percentage: number;
}

export class MutualService {
  private static instance: MutualService;
  private authService: AuthService;
  private followVerification: FollowVerificationService;
  private followAdapter: FollowStorageAdapter;

  // In-memory cache for mutual status (cleared on logout)
  private mutualStatusCache: LRUCache<boolean> = new LRUCache<boolean>(getCacheSize(1000, 500, 200));

  private constructor() {
    this.authService = AuthService.getInstance();
    this.followVerification = FollowVerificationService.getInstance();
    this.followAdapter = new FollowStorageAdapter();
  }

  public static getInstance(): MutualService {
    if (!MutualService.instance) {
      MutualService.instance = new MutualService();
    }
    return MutualService.instance;
  }

  /**
   * Get all follows (newest first) for mutual checking
   * Reads from browserItems (localStorage), falls back to files if empty
   */
  public async getFollowsForMutualCheck(): Promise<FollowItem[]> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return [];

    // Read from browserItems (localStorage)
    let browserItems = this.followAdapter.getBrowserItems();

    // If browserItems is empty, initialize from files (first load)
    if (browserItems.length === 0) {
      const fileItems = await this.followAdapter.getFileItems();
      if (fileItems.length > 0) {
        this.followAdapter.setBrowserItems(fileItems);
        browserItems = fileItems;
      }
    }

    // Reverse to get newest first (tag order in Kind 3 = chronological, oldest first)
    return [...browserItems].reverse();
  }

  /**
   * Check mutual status for a batch of pubkeys.
   * Default: parallel (fast, for list rendering).
   * With onProgress: sequential (reliable, for change detection).
   */
  public async checkMutualStatusBatch(
    items: FollowItem[],
    onProgress?: (checked: number, total: number) => void
  ): Promise<MutualItemWithStatus[]> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return items.map(item => ({ ...item, isMutual: false }));

    // Sequential mode: reliable for change detection (no relay overload)
    if (onProgress) {
      return this.checkBatchSequential(items, currentUser.pubkey, onProgress);
    }

    // Parallel mode: fast for list rendering
    return this.checkBatchParallel(items, currentUser.pubkey);
  }

  private async checkBatchParallel(
    items: FollowItem[],
    currentUserPubkey: string
  ): Promise<MutualItemWithStatus[]> {
    return Promise.all(
      items.map(async (item) => {
        if (this.mutualStatusCache.has(item.pubkey)) {
          return { ...item, isMutual: this.mutualStatusCache.get(item.pubkey)! };
        }
        const isMutual = await this.checkIfMutual(item.pubkey, currentUserPubkey);
        this.mutualStatusCache.set(item.pubkey, isMutual);
        return { ...item, isMutual };
      })
    );
  }

  private static readonly CONCURRENCY_LIMIT = 5;

  private async checkBatchSequential(
    items: FollowItem[],
    currentUserPubkey: string,
    onProgress: (checked: number, total: number) => void
  ): Promise<MutualItemWithStatus[]> {
    const results: MutualItemWithStatus[] = new Array(items.length);
    let checked = 0;

    // Process in chunks of CONCURRENCY_LIMIT
    for (let i = 0; i < items.length; i += MutualService.CONCURRENCY_LIMIT) {
      const chunk = items.slice(i, i + MutualService.CONCURRENCY_LIMIT);

      await Promise.all(chunk.map(async (item, j) => {
        const isMutual = await this.checkIfMutual(item.pubkey, currentUserPubkey);
        this.mutualStatusCache.set(item.pubkey, isMutual);
        results[i + j] = { ...item, isMutual };
        checked++;
        onProgress(checked, items.length);
      }));
    }

    return results;
  }

  /**
   * Get total stats (requires checking ALL follows)
   * Called once when opening the tab
   */
  public async getTotalStats(): Promise<MutualStats> {
    const follows = await this.getFollowsForMutualCheck();
    const totalFollowing = follows.length;

    // Count mutuals from cache (may be incomplete on first load)
    let mutualCount = 0;
    for (const follow of follows) {
      if (this.mutualStatusCache.get(follow.pubkey) === true) {
        mutualCount++;
      }
    }

    const percentage = totalFollowing > 0
      ? Math.round((mutualCount / totalFollowing) * 100)
      : 0;

    return { totalFollowing, mutualCount, percentage };
  }

  /**
   * Update stats after checking a batch
   */
  public calculateStatsFromCache(totalFollowing: number): MutualStats {
    let mutualCount = 0;
    for (const isMutual of this.mutualStatusCache.values()) {
      if (isMutual) mutualCount++;
    }

    const percentage = totalFollowing > 0
      ? Math.round((mutualCount / totalFollowing) * 100)
      : 0;

    return { totalFollowing, mutualCount, percentage };
  }

  /**
   * Check if a specific user follows back.
   * Delegates to FollowVerificationService (NIP-65 outbox-aware, tri-state).
   * For the list view, 'unknown' collapses to false (no badge).
   */
  private async checkIfMutual(
    userPubkey: string,
    _currentUserPubkey: string
  ): Promise<boolean> {
    return this.followVerification.followsBackSimple(userPubkey);
  }

  /**
   * Clear cache for a specific pubkey
   */
  public clearCacheForPubkey(pubkey: string): void {
    this.mutualStatusCache.delete(pubkey);
  }

  /**
   * Clear cache (call on logout)
   */
  public clearCache(): void {
    this.mutualStatusCache.clear();
  }
}
