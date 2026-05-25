/**
 * ProfileMountsOrchestrator
 * Manages NIP-78 events for profile-mounted bookmark folders
 *
 * kind:30078 with d-tag "noornote/profile-mounts" stores which bookmark
 * folders a user has mounted to their profile page.
 *
 * This is a NoorNote-specific feature - other clients ignore it.
 *
 * @purpose Publish/fetch profile mounts to/from relays
 * @used-by ProfileView, BookmarkSecondaryManager
 */

import { NostrTransport } from '../transport/NostrTransport';
import { AuthService } from '../AuthService';
import { ProfileMountsService } from '../ProfileMountsService';
import { SystemLogger } from '../SystemLogger';
import { LRUCache, getCacheSize } from '../../helpers/LRUCache';

const NIP78_KIND = 30078;
const D_TAG = 'noornote/profile-mounts';

interface ProfileMountsContent {
  version: 1;
  mounts: string[];  // Array of folder names (= d-tags of kind:30003 sets)
}

export class ProfileMountsOrchestrator {
  private static instance: ProfileMountsOrchestrator;
  private transport: NostrTransport;
  private authService: AuthService;
  private profileMountsService: ProfileMountsService;
  private systemLogger: SystemLogger;

  // Cache for fetched profile mounts (pubkey -> mounts[])
  private cache = new LRUCache<string[]>(getCacheSize(100, 50, 30), 60000); // 1 minute TTL

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.authService = AuthService.getInstance();
    this.profileMountsService = ProfileMountsService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): ProfileMountsOrchestrator {
    if (!ProfileMountsOrchestrator.instance) {
      ProfileMountsOrchestrator.instance = new ProfileMountsOrchestrator();
    }
    return ProfileMountsOrchestrator.instance;
  }

  /**
   * Publish current user's profile mounts to relays
   * Called automatically when mounts change
   */
  public async publishToRelays(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) {
      throw new Error('No write relays available');
    }

    // Get current mounts from service
    const mounts = this.profileMountsService.getMounts();

    // Build content
    const content: ProfileMountsContent = {
      version: 1,
      mounts: mounts
    };

    // Create kind:30078 event
    const event = {
      kind: NIP78_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', D_TAG]
      ],
      content: JSON.stringify(content),
      pubkey: currentUser.pubkey
    };

    const signed = await this.authService.signEvent(event);

    if (!signed) {
      throw new Error('Failed to sign profile mounts event');
    }

    await this.transport.publishContent(signed);

    // Update cache for own profile
    this.cache.set(currentUser.pubkey, mounts);

    this.systemLogger.info('ProfileMountsOrchestrator',
      `Published profile mounts: ${mounts.length} folders`
    );
  }

  /**
   * Fetch profile mounts for a given user from relays
   * @param pubkey - The user's pubkey to fetch mounts for
   * @param forceRefresh - Skip cache and fetch fresh data
   */
  public async fetchFromRelays(pubkey: string, forceRefresh: boolean = false): Promise<string[]> {
    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = this.cache.get(pubkey);
      if (cached !== undefined) {
        return cached;
      }
    }

    const readRelays = this.transport.getReadRelays();
    if (readRelays.length === 0) {
      return [];
    }

    try {
      const events = await this.transport.fetch(readRelays, [{
        kinds: [NIP78_KIND],
        authors: [pubkey],
        '#d': [D_TAG],
        limit: 1
      }], 5000, false, 'ProfileMountsOrch');

      if (events.length === 0) {
        // No profile mounts found - cache empty result
        this.cache.set(pubkey, []);
        return [];
      }

      // Get most recent event (should only be one due to replaceable nature)
      const event = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!event) return [];

      // Parse content
      const mounts = this.parseContent(event.content);

      // Cache result
      this.cache.set(pubkey, mounts);

      return mounts;
    } catch (error) {
      this.systemLogger.error('ProfileMountsOrchestrator',
        `Failed to fetch profile mounts for ${pubkey}: ${error}`
      );
      return [];
    }
  }

  /**
   * Sync current user's mounts from relays (overwrite local)
   */
  public async syncFromRelays(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    const mounts = await this.fetchFromRelays(currentUser.pubkey, true);
    this.profileMountsService.setMountsFromRelay(mounts);

    this.systemLogger.info('ProfileMountsOrchestrator',
      `Synced from relays: ${mounts.length} folders`
    );
  }

  /**
   * Clear cache for a specific user or all
   */
  public clearCache(pubkey?: string): void {
    if (pubkey) {
      this.cache.delete(pubkey);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Parse event content to extract mounts array
   */
  private parseContent(content: string): string[] {
    if (!content) return [];

    try {
      const parsed = JSON.parse(content) as ProfileMountsContent;
      if (parsed.version === 1 && Array.isArray(parsed.mounts)) {
        return parsed.mounts;
      }
      return [];
    } catch {
      return [];
    }
  }
}
