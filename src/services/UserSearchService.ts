/**
 * UserSearchService - Hybrid user search (local + remote)
 *
 * Search priority:
 * 1. Local: Search through followed users (fast, immediate)
 * 2. Remote: NIP-50 profile search via relays (async, streamed)
 *
 * @service UserSearchService
 * @used-by SearchSpotlight
 */

import { FollowStorageAdapter } from './sync/adapters/FollowStorageAdapter';
import { UserProfileService, type UserProfile } from './UserProfileService';
import { SearchOrchestrator } from './orchestration/SearchOrchestrator';
import { extractDisplayName } from '../helpers/extractDisplayName';

export interface UserSearchResult {
  pubkey: string;
  name?: string;
  displayName?: string;
  picture?: string;
  nip05?: string;
  isFollowing: boolean;
}

export interface UserSearchCallbacks {
  onLocalResults: (results: UserSearchResult[]) => void;
  onRemoteResults: (results: UserSearchResult[]) => void;
  onComplete: () => void;
}

export class UserSearchService {
  private static instance: UserSearchService;
  private followAdapter: FollowStorageAdapter;
  private userProfileService: UserProfileService;
  private searchOrchestrator: SearchOrchestrator;

  /** Cache of follow pubkeys for quick lookup */
  private followPubkeys: Set<string> = new Set();

  private constructor() {
    this.followAdapter = new FollowStorageAdapter();
    this.userProfileService = UserProfileService.getInstance();
    this.searchOrchestrator = SearchOrchestrator.getInstance();
  }

  public static getInstance(): UserSearchService {
    if (!UserSearchService.instance) {
      UserSearchService.instance = new UserSearchService();
    }
    return UserSearchService.instance;
  }

  /**
   * Search for users - returns results via callbacks as they become available
   * @param query - Search query (username, display name, or npub)
   * @param callbacks - Callbacks for streaming results
   * @returns AbortController to cancel the search
   */
  public search(query: string, callbacks: UserSearchCallbacks): AbortController {
    const abortController = new AbortController();

    // Minimum query length
    if (query.length < 2) {
      callbacks.onLocalResults([]);
      callbacks.onComplete();
      return abortController;
    }

    const queryLower = query.toLowerCase();

    // Run local and remote searches in parallel
    this.searchLocal(queryLower, abortController.signal)
      .then(localResults => {
        if (!abortController.signal.aborted) {
          callbacks.onLocalResults(localResults);
        }
      });

    this.searchRemote(queryLower, abortController.signal)
      .then(remoteResults => {
        if (!abortController.signal.aborted) {
          callbacks.onRemoteResults(remoteResults);
          callbacks.onComplete();
        }
      })
      .catch(() => {
        if (!abortController.signal.aborted) {
          callbacks.onComplete();
        }
      });

    return abortController;
  }

  /**
   * Search through followed users (local, fast)
   */
  private async searchLocal(query: string, signal: AbortSignal): Promise<UserSearchResult[]> {
    const follows = this.followAdapter.getBrowserItems();

    // Update follow pubkeys cache
    this.followPubkeys = new Set(follows.map(f => f.pubkey));

    if (follows.length === 0) {
      return [];
    }

    const results: UserSearchResult[] = [];
    const profilePromises: Promise<void>[] = [];

    // Fetch profiles and filter by query
    for (const follow of follows) {
      if (signal.aborted) break;

      const promise = this.userProfileService.getUserProfile(follow.pubkey)
        .then(profile => {
          if (signal.aborted) return;

          // Check if profile matches query
          if (this.profileMatchesQuery(profile, query)) {
            results.push(this.profileToSearchResult(profile, true));
          }
        })
        .catch(() => {
          // Skip profiles that fail to load
        });

      profilePromises.push(promise);
    }

    // Wait for all profiles to load
    await Promise.all(profilePromises);

    // Sort by relevance (exact match first, then alphabetically)
    return this.sortResults(results, query);
  }

  /**
   * Search via NIP-50 relays (remote, slower)
   */
  private async searchRemote(query: string, signal: AbortSignal): Promise<UserSearchResult[]> {
    if (signal.aborted) return [];

    try {
      const remoteProfiles = await this.searchOrchestrator.searchProfiles(query, 15);

      if (signal.aborted) return [];

      // Convert to UserSearchResult, mark if following
      const results: UserSearchResult[] = remoteProfiles
        .filter(p => !this.followPubkeys.has(p.pubkey)) // Exclude already-shown follows
        .map(p => {
          const result: UserSearchResult = { pubkey: p.pubkey, isFollowing: false };
          if (p.name) result.name = p.name;
          if (p.display_name) result.displayName = p.display_name;
          if (p.picture) result.picture = p.picture;
          if (p.nip05) result.nip05 = p.nip05;
          return result;
        });

      return results;
    } catch {
      return [];
    }
  }

  /**
   * Check if profile matches search query
   */
  private profileMatchesQuery(profile: UserProfile, query: string): boolean {
    const name = (profile.name || '').toLowerCase();
    const displayName = (profile.display_name || '').toLowerCase();
    const nip05 = (profile.nip05 || '').toLowerCase();

    return name.includes(query) ||
           displayName.includes(query) ||
           nip05.includes(query);
  }

  /**
   * Convert UserProfile to UserSearchResult
   */
  private profileToSearchResult(profile: UserProfile, isFollowing: boolean): UserSearchResult {
    const result: UserSearchResult = { pubkey: profile.pubkey, isFollowing };
    if (profile.name) result.name = profile.name;
    if (profile.display_name) result.displayName = profile.display_name;
    if (profile.picture) result.picture = profile.picture;
    if (profile.nip05) result.nip05 = profile.nip05;
    return result;
  }

  /**
   * Sort results by relevance
   */
  private sortResults(results: UserSearchResult[], query: string): UserSearchResult[] {
    return results.sort((a, b) => {
      const aName = extractDisplayName(a as any) || '';
      const bName = extractDisplayName(b as any) || '';
      const aLower = aName.toLowerCase();
      const bLower = bName.toLowerCase();

      // Exact match first
      const aExact = aLower === query || a.name?.toLowerCase() === query;
      const bExact = bLower === query || b.name?.toLowerCase() === query;
      if (aExact && !bExact) return -1;
      if (bExact && !aExact) return 1;

      // Starts with query second
      const aStarts = aLower.startsWith(query) || (a.name?.toLowerCase().startsWith(query) ?? false);
      const bStarts = bLower.startsWith(query) || (b.name?.toLowerCase().startsWith(query) ?? false);
      if (aStarts && !bStarts) return -1;
      if (bStarts && !aStarts) return 1;

      // Alphabetically
      return aLower.localeCompare(bLower);
    });
  }
}
