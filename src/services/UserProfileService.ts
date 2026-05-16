/**
 * User Profile Service (also exported as ProfileService)
 * Resolves user pubkeys to usernames, profile pictures, and metadata
 * Uses ProfileOrchestrator for fetching
 *
 * LRU CACHE STRATEGY:
 * - Memory-only LRU cache (via LRUCache helper)
 * - Platform-aware size: Desktop > Web > Mobile
 * - Fresh on every app start
 */

import { ProfileOrchestrator } from './orchestration/ProfileOrchestrator';
import { LRUCache, getCacheSize } from '../helpers/LRUCache';
import { getAvatarFallback } from '../helpers/avatarFallback';
import { hexToNpub } from '../helpers/nip19';

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

  /** LRU Cache for profiles (platform-aware size) */
  private profileCache = new LRUCache<UserProfile>(getCacheSize(2000, 1000, 500));

  private orchestrator: ProfileOrchestrator;
  private fetchingProfiles: Map<string, Promise<UserProfile>> = new Map();
  private profileUpdateCallbacks: Map<string, Set<(profile: UserProfile) => void>> = new Map();
  /** Listeners that want to be notified for EVERY profile update (any pubkey). */
  private anyProfileUpdateCallbacks: Set<(pubkey: string, profile: UserProfile) => void> = new Set();

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
   * Get username ONLY (lightweight, fast)
   * Returns cached username or null if not yet loaded.
   * For rendering use getDisplayName() — it always returns a usable string.
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
   * Returns cached picture URL or null if not yet loaded.
   * For rendering use getDisplayPicture() — it always returns a usable URL.
   */
  public getProfilePicture(pubkey: string): string | null {
    const cached = this.profileCache.get(pubkey);
    return cached?.picture || null;
  }

  /**
   * Render-ready name: real cached name, or a shortened npub fallback so the
   * UI never has to invent its own placeholder. Triggers a background fetch
   * on cache miss; subscribers will be updated when the real name arrives.
   */
  public getDisplayName(pubkey: string): string {
    return UserProfileService.displayNameOf(this.profileCache.get(pubkey) ?? null, pubkey);
  }

  /**
   * Render-ready picture URL: real cached picture, or a deterministic identicon
   * so the UI never has to render an empty <img>. Same cache-miss semantics as
   * getDisplayName().
   */
  public getDisplayPicture(pubkey: string): string {
    return UserProfileService.displayPictureOf(this.profileCache.get(pubkey) ?? null, pubkey);
  }

  /**
   * Extract render-ready name from a profile object (e.g. inside a
   * subscribeToProfile callback). Always returns a usable string.
   */
  public static displayNameOf(profile: UserProfile | null, pubkey: string): string {
    const real = profile?.display_name || profile?.name || profile?.username;
    if (real) return real;
    const npub = hexToNpub(pubkey);
    return npub ? `@${npub.slice(0, 12)}…` : pubkey.slice(0, 8);
  }

  /**
   * Extract render-ready picture from a profile object. Always returns a
   * usable URL (real or identicon).
   */
  public static displayPictureOf(profile: UserProfile | null, pubkey: string): string {
    return profile?.picture || getAvatarFallback(pubkey);
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
    return this.profileCache.get(pubkey) ?? null;
  }

  /**
   * Get full user profile
   * Returns cached profile or fetches from relays
   */
  public async getUserProfile(pubkey: string): Promise<UserProfile> {
    // Check cache first (LRU touch handled by LRUCache.get())
    const cached = this.profileCache.get(pubkey);
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
      this.profileCache.set(pubkey, profile);

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
      const cached = this.profileCache.get(pubkey);
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
          this.profileCache.set(pubkey, profile);
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
    const cached = this.profileCache.get(pubkey);
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
    this.anyProfileUpdateCallbacks.forEach(cb => cb(pubkey, profile));
  }

  /**
   * Subscribe to ALL profile updates (any pubkey). Use for cross-cutting consumers
   * like mention-chip DOM patchers that don't know in advance which pubkeys will
   * appear. Returns an unsubscribe function.
   */
  public subscribeToAnyProfileUpdate(callback: (pubkey: string, profile: UserProfile) => void): () => void {
    this.anyProfileUpdateCallbacks.add(callback);
    return () => {
      this.anyProfileUpdateCallbacks.delete(callback);
    };
  }

  /**
   * Manually set a profile in cache (e.g., after onboarding publish)
   */
  public setCachedProfile(pubkey: string, profile: UserProfile): void {
    this.profileCache.set(pubkey, profile);
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
      maxSize: getCacheSize(2000, 1000, 500)
    };
  }
}

/** Alias for UserProfileService (microservice naming convention) */
export const ProfileService = UserProfileService;
