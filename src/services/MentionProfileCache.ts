/**
 * MentionProfileCache
 * Global cache for mention autocomplete profiles
 * Preloads profiles at login for instant mentions
 */

import { UserProfileService } from './UserProfileService';
import type { MentionSuggestion } from '../components/mentions/MentionAutocomplete';
import { hexToNpub } from '../helpers/nip19';

export class MentionProfileCache {
  private static instance: MentionProfileCache;
  private cachedSuggestions: MentionSuggestion[] | null = null;
  private isLoading: boolean = false;
  private loadPromise: Promise<MentionSuggestion[]> | null = null;

  private userProfileService: UserProfileService;

  private constructor() {
    this.userProfileService = UserProfileService.getInstance();
  }

  public static getInstance(): MentionProfileCache {
    if (!MentionProfileCache.instance) {
      MentionProfileCache.instance = new MentionProfileCache();
    }
    return MentionProfileCache.instance;
  }

  /**
   * Preload profiles for mention autocomplete (call at login)
   * @param followingPubkeys - List of followed pubkeys
   */
  public async preloadProfiles(followingPubkeys: string[]): Promise<void> {
    if (this.cachedSuggestions !== null) {
      return;
    }

    if (this.isLoading) {
      await this.loadPromise;
      return;
    }

    this.isLoading = true;

    this.loadPromise = (async () => {
      try {
        const profiles = await this.userProfileService.getUserProfiles(followingPubkeys);

        const suggestions: MentionSuggestion[] = [];
        profiles.forEach((profile, pubkey) => {
          const username = profile.name || profile.display_name || '';
          const displayName = profile.display_name || profile.name || '';

          if (!username) return;

          const npub = hexToNpub(pubkey);
          if (!npub) return;

          const suggestion: MentionSuggestion = {
            pubkey,
            npub,
            username,
            displayName,
            picture: profile.picture || ''
          };
          if (profile.nip05) suggestion.nip05 = profile.nip05;
          suggestions.push(suggestion);
        });

        suggestions.sort((a, b) => a.username.localeCompare(b.username));

        this.cachedSuggestions = suggestions;

        return suggestions;
      } catch (error) {
        return [];
      } finally {
        this.isLoading = false;
        this.loadPromise = null;
      }
    })();

    await this.loadPromise;
  }

  /**
   * Get cached suggestions (instant if preloaded)
   * @param followingPubkeys - Fallback if not preloaded
   */
  public async getSuggestions(followingPubkeys: string[]): Promise<MentionSuggestion[]> {
    // If cached, return instantly
    if (this.cachedSuggestions !== null) {
      return this.cachedSuggestions;
    }

    // If loading, wait for it
    if (this.isLoading && this.loadPromise) {
      return await this.loadPromise;
    }

    // Not preloaded, load now (fallback)
    await this.preloadProfiles(followingPubkeys);
    return this.cachedSuggestions || [];
  }

  /**
   * Clear cache (on logout)
   */
  public clear(): void {
    this.cachedSuggestions = null;
    this.isLoading = false;
    this.loadPromise = null;
  }
}
