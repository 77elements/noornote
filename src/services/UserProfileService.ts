/**
 * User Profile Service (also exported as ProfileService)
 * Resolves user pubkeys to usernames, profile pictures, and metadata
 * Uses ProfileOrchestrator for fetching
 *
 * LRU CACHE STRATEGY:
 * - Memory-only cache (no localStorage)
 * - LRU eviction when cache exceeds MAX_CACHE_SIZE
 * - Fresh on every app start
 */

import { ProfileOrchestrator } from './orchestration/ProfileOrchestrator';

export interface UserProfile {
  pubkey: string;
  name?: string;
  display_name?: string;
  username?: string;
  picture?: string;
  about?: string;
  nip05?: string;
  nip05s?: string[]; // Multiple NIP-05 addresses from tags (Animestr-style)
  verified?: boolean;
  lud06?: string;
  lud16?: string;
  website?: string;
  banner?: string;
  lastUpdated?: number;
}

export class UserProfileService {
  private static instance: UserProfileService;

  /** LRU Cache for profiles */
  private profileCache: Map<string, UserProfile> = new Map();
  private readonly MAX_CACHE_SIZE = 500;

  private orchestrator: ProfileOrchestrator;
  private fetchingProfiles: Map<string, Promise<UserProfile>> = new Map();
  private profileUpdateCallbacks: Map<string, Set<(profile: UserProfile) => void>> = new Map();

  /** Track failed fetches to prevent rapid retry storms (pubkey → timestamp) */
  private failedFetches: Map<string, number> = new Map();
  private readonly FAILED_FETCH_COOLDOWN = 2000; // 2 seconds

  private constructor() {
    this.orchestrator = ProfileOrchestrator.getInstance();
  }

  public static getInstance(): UserProfileService {
    if (!UserProfileService.instance) {
      UserProfileService.instance = new UserProfileService();
    }
    return UserProfileService.instance;
  }

  /**
   * Add profile to LRU cache
   * Moves to end if exists, evicts oldest if full
   */
  private addToCache(pubkey: string, profile: UserProfile): void {
    // Delete first to move to end (LRU: most recent at end)
    if (this.profileCache.has(pubkey)) {
      this.profileCache.delete(pubkey);
    }

    // Evict oldest entries if cache is full
    while (this.profileCache.size >= this.MAX_CACHE_SIZE) {
      const oldestKey = this.profileCache.keys().next().value;
      if (oldestKey) {
        this.profileCache.delete(oldestKey);
      }
    }

    this.profileCache.set(pubkey, profile);
  }

  /**
   * Get from cache and mark as recently used
   */
  private getFromCache(pubkey: string): UserProfile | null {
    const profile = this.profileCache.get(pubkey);
    if (profile) {
      // Move to end (mark as recently used)
      this.profileCache.delete(pubkey);
      this.profileCache.set(pubkey, profile);
      return profile;
    }
    return null;
  }

  /**
   * Get username ONLY (lightweight, fast)
   * Returns cached username or null if not yet loaded
   */
  public getUsername(pubkey: string): string | null {
    const cached = this.profileCache.get(pubkey);
    if (cached) {
      return cached.display_name || cached.name || cached.username || null;
    }
    return null;
  }

  /**
   * Get profile picture ONLY (lightweight, fast)
   * Returns cached picture or null if not yet loaded
   */
  public getProfilePicture(pubkey: string): string | null {
    const cached = this.profileCache.get(pubkey);
    return cached?.picture || null;
  }

  /**
   * Check if profile is cached (without fetching)
   */
  public hasProfile(pubkey: string): boolean {
    return this.profileCache.has(pubkey);
  }

  /**
   * Get cached profile (without fetching)
   */
  public getCachedProfile(pubkey: string): UserProfile | null {
    return this.getFromCache(pubkey);
  }

  /**
   * Get full user profile
   * Returns cached profile or fetches from relays
   */
  public async getUserProfile(pubkey: string): Promise<UserProfile> {
    // Check cache first
    const cached = this.getFromCache(pubkey);
    if (cached) {
      return cached;
    }

    // Deduplication: if already fetching, wait for that request
    if (this.fetchingProfiles.has(pubkey)) {
      return await this.fetchingProfiles.get(pubkey)!;
    }

    // Check if recently failed - return default profile during cooldown
    const lastFailed = this.failedFetches.get(pubkey);
    if (lastFailed && Date.now() - lastFailed < this.FAILED_FETCH_COOLDOWN) {
      return this.getDefaultProfile(pubkey);
    }

    // Start new fetch
    const fetchPromise = this.fetchProfileFromRelays(pubkey);
    this.fetchingProfiles.set(pubkey, fetchPromise);

    try {
      const profile = await fetchPromise;

      // Clear any previous failure on success
      this.failedFetches.delete(pubkey);

      // Add to cache
      this.addToCache(pubkey, profile);

      // Notify subscribers
      this.notifyProfileUpdate(pubkey, profile);
      return profile;
    } catch (error) {
      console.warn(`Failed to fetch profile for ${pubkey}:`, error);
      // Record failure timestamp to prevent rapid retries
      this.failedFetches.set(pubkey, Date.now());
      return this.getDefaultProfile(pubkey);
    } finally {
      this.fetchingProfiles.delete(pubkey);
    }
  }

  /**
   * Check if user is verified (has valid NIP-05)
   */
  public isVerified(profile: UserProfile): boolean {
    return profile.verified === true && !!profile.nip05;
  }

  /**
   * Fetch multiple user profiles efficiently
   */
  public async getUserProfiles(pubkeys: string[]): Promise<Map<string, UserProfile>> {
    const result = new Map<string, UserProfile>();
    const toFetch: string[] = [];

    // Check cache first
    for (const pubkey of pubkeys) {
      const cached = this.getFromCache(pubkey);
      if (cached) {
        result.set(pubkey, cached);
      } else {
        toFetch.push(pubkey);
      }
    }

    // Fetch missing profiles
    if (toFetch.length > 0) {
      try {
        const fetchedProfiles = await this.fetchMultipleProfilesFromRelays(toFetch);
        fetchedProfiles.forEach((profile, pubkey) => {
          this.addToCache(pubkey, profile);
          result.set(pubkey, profile);
        });
      } catch (error) {
        console.warn('Failed to fetch user profiles:', error);
        // Return default profiles for missing
        toFetch.forEach(pubkey => {
          if (!result.has(pubkey)) {
            result.set(pubkey, this.getDefaultProfile(pubkey));
          }
        });
      }
    }

    return result;
  }

  /**
   * Fetch single profile from relays (via ProfileOrchestrator)
   */
  private async fetchProfileFromRelays(pubkey: string): Promise<UserProfile> {
    const profile = await this.orchestrator.fetchProfile(pubkey);

    if (profile) {
      return profile as UserProfile;
    }

    // Return default profile if fetch failed
    return this.getDefaultProfile(pubkey);
  }

  /**
   * Fetch multiple profiles efficiently (via ProfileOrchestrator)
   */
  private async fetchMultipleProfilesFromRelays(pubkeys: string[]): Promise<Map<string, UserProfile>> {
    const profiles = await this.orchestrator.fetchMultipleProfiles(pubkeys);

    // Convert to UserProfile format and add defaults for missing
    const result = new Map<string, UserProfile>();

    pubkeys.forEach(pubkey => {
      const profile = profiles.get(pubkey);
      if (profile) {
        result.set(pubkey, profile as UserProfile);
      } else {
        result.set(pubkey, this.getDefaultProfile(pubkey));
      }
    });

    return result;
  }

  /**
   * Create default profile for a pubkey
   */
  private getDefaultProfile(pubkey: string): UserProfile {
    return {
      pubkey,
      lastUpdated: Date.now()
    };
  }

  /**
   * Subscribe to profile updates (like nostr-react useProfile pattern)
   */
  public subscribeToProfile(pubkey: string, callback: (profile: UserProfile) => void): () => void {
    if (!this.profileUpdateCallbacks.has(pubkey)) {
      this.profileUpdateCallbacks.set(pubkey, new Set());
    }

    this.profileUpdateCallbacks.get(pubkey)!.add(callback);

    // Check cache first, fetch only if not cached
    const cached = this.getFromCache(pubkey);
    if (cached) {
      // Immediate callback with cached data
      callback(cached);
    } else {
      // Fetch from relays
      this.getUserProfile(pubkey).then(callback).catch(() => {
        // Silent fail
      });
    }

    // Return unsubscribe function
    return () => {
      const callbacks = this.profileUpdateCallbacks.get(pubkey);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.profileUpdateCallbacks.delete(pubkey);
        }
      }
    };
  }

  /**
   * Notify all subscribers when profile updates
   */
  private notifyProfileUpdate(pubkey: string, profile: UserProfile): void {
    const callbacks = this.profileUpdateCallbacks.get(pubkey);
    if (callbacks) {
      callbacks.forEach(callback => callback(profile));
    }
  }

  /**
   * Manually set a profile in cache (e.g., after onboarding publish)
   */
  public setCachedProfile(pubkey: string, profile: UserProfile): void {
    this.addToCache(pubkey, profile);
    this.notifyProfileUpdate(pubkey, profile);
  }

  /**
   * Invalidate cached profile (e.g., after profile edit)
   */
  public invalidateProfile(pubkey: string): void {
    this.profileCache.delete(pubkey);
  }

  /**
   * Clear all cached profiles
   */
  public clearCache(): void {
    this.profileCache.clear();
    this.failedFetches.clear();
  }

  /**
   * Get cache stats (for debugging)
   */
  public getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.profileCache.size,
      maxSize: this.MAX_CACHE_SIZE
    };
  }
}

/** Alias for UserProfileService (microservice naming convention) */
export const ProfileService = UserProfileService;
