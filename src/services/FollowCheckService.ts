/**
 * FollowCheckService
 * Provides fast follow-status checks for pubkeys
 *
 * @purpose Check if a pubkey is in the user's follow list
 * @used-by MessagesView (Known/Unknown tabs), DMService
 *
 * Uses browserItems (localStorage) for fast lookups.
 * Initializes from file storage on first access if browser is empty.
 */

import { FollowStorageAdapter } from '../lists/follows';
import { AuthService } from './AuthService';

export class FollowCheckService {
  private static instance: FollowCheckService;
  private followAdapter: FollowStorageAdapter;
  private authService: AuthService;

  // In-memory set for O(1) lookups
  private followedPubkeys: Set<string> = new Set();
  private initialized: boolean = false;

  private constructor() {
    this.followAdapter = new FollowStorageAdapter();
    this.authService = AuthService.getInstance();
  }

  public static getInstance(): FollowCheckService {
    if (!FollowCheckService.instance) {
      FollowCheckService.instance = new FollowCheckService();
    }
    return FollowCheckService.instance;
  }

  /**
   * Initialize the follow set from storage
   * Called automatically on first check, but can be called explicitly
   */
  public async init(): Promise<void> {
    if (this.initialized) return;

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return;

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

    // Build the set
    this.followedPubkeys.clear();
    for (const item of browserItems) {
      this.followedPubkeys.add(item.pubkey);
    }

    this.initialized = true;
  }

  /**
   * Check if a pubkey is followed by the current user
   * @param pubkey - The pubkey to check (hex format)
   * @returns true if followed, false otherwise
   */
  public async isFollowing(pubkey: string): Promise<boolean> {
    await this.init();
    return this.followedPubkeys.has(pubkey);
  }

  /**
   * Synchronous check - only use if you're sure init() was called
   * @param pubkey - The pubkey to check (hex format)
   */
  public isFollowingSync(pubkey: string): boolean {
    return this.followedPubkeys.has(pubkey);
  }

  /**
   * Get all followed pubkeys
   */
  public async getFollowedPubkeys(): Promise<Set<string>> {
    await this.init();
    return new Set(this.followedPubkeys);
  }

  /**
   * Get count of followed users
   */
  public async getFollowCount(): Promise<number> {
    await this.init();
    return this.followedPubkeys.size;
  }

  /**
   * Refresh the follow set (call after follow list changes)
   */
  public async refresh(): Promise<void> {
    this.initialized = false;
    await this.init();
  }

  /**
   * Clear cache (call on logout)
   */
  public clear(): void {
    this.followedPubkeys.clear();
    this.initialized = false;
  }
}
