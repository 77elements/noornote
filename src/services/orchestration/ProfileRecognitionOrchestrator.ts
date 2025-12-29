/**
 * ProfileRecognitionOrchestrator
 * Manages NIP-78 events for profile encounter storage
 *
 * kind:30078 with d-tag "noornote:profile-encounters" stores profile
 * recognition data (first encounter snapshots for followed users)
 *
 * This is a NoorNote-specific feature - other clients ignore it.
 *
 * @purpose Publish/fetch profile encounters to/from relays
 * @used-by ProfileRecognitionService
 */

import { NostrTransport } from '../transport/NostrTransport';
import { AuthService } from '../AuthService';
import { SystemLogger } from '../../components/system/SystemLogger';
import type { ProfileEncounterData } from '../storage/ProfileEncounterFileStorage';

const NIP78_KIND = 30078;
const D_TAG = 'noornote:profile-encounters';

export class ProfileRecognitionOrchestrator {
  private static instance: ProfileRecognitionOrchestrator;
  private transport: NostrTransport;
  private authService: AuthService;
  private systemLogger: SystemLogger;

  // Cache for fetched encounters (pubkey -> encounters)
  private cache: Map<string, { data: ProfileEncounterData; fetchedAt: number }> = new Map();
  private readonly CACHE_TTL = 60000; // 1 minute cache

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.authService = AuthService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): ProfileRecognitionOrchestrator {
    if (!ProfileRecognitionOrchestrator.instance) {
      ProfileRecognitionOrchestrator.instance = new ProfileRecognitionOrchestrator();
    }
    return ProfileRecognitionOrchestrator.instance;
  }

  /**
   * Publish current user's profile encounters to relays
   * Called automatically via debounced auto-save
   */
  public async publishToRelays(encounterData: ProfileEncounterData): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) {
      throw new Error('No write relays available');
    }

    // Build content (encounters map)
    const content = JSON.stringify({
      version: 1,
      encounters: encounterData.encounters
    });

    // Create kind:30078 event
    const event = {
      kind: NIP78_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', D_TAG]
      ],
      content: content,
      pubkey: currentUser.pubkey
    };

    const signed = await this.authService.signEvent(event);

    if (!signed) {
      throw new Error('Failed to sign profile encounters event');
    }

    await this.transport.publish(writeRelays, signed);

    // Update cache for own profile
    this.cache.set(currentUser.pubkey, {
      data: encounterData,
      fetchedAt: Date.now()
    });

    this.systemLogger.info('ProfileRecognitionOrchestrator',
      `Published encounters: ${Object.keys(encounterData.encounters).length} profiles`
    );
  }

  /**
   * Fetch profile encounters for a given user from relays
   * @param pubkey - The user's pubkey to fetch encounters for
   * @param forceRefresh - Skip cache and fetch fresh data
   */
  public async fetchFromRelays(pubkey: string, forceRefresh: boolean = false): Promise<ProfileEncounterData | null> {
    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = this.cache.get(pubkey);
      if (cached && (Date.now() - cached.fetchedAt) < this.CACHE_TTL) {
        return cached.data;
      }
    }

    const readRelays = this.transport.getReadRelays();
    if (readRelays.length === 0) {
      return null;
    }

    try {
      const events = await this.transport.fetch(readRelays, [{
        kinds: [NIP78_KIND],
        authors: [pubkey],
        '#d': [D_TAG],
        limit: 1
      }], 5000);

      if (events.length === 0) {
        // No profile encounters found - cache empty result
        const emptyData: ProfileEncounterData = {
          encounters: {},
          lastModified: Math.floor(Date.now() / 1000)
        };
        this.cache.set(pubkey, { data: emptyData, fetchedAt: Date.now() });
        return null;
      }

      // Get most recent event (should only be one due to replaceable nature)
      const event = events.sort((a, b) => b.created_at - a.created_at)[0];

      // Parse content
      const encounterData = this.parseContent(event.content);

      // Cache result
      this.cache.set(pubkey, { data: encounterData, fetchedAt: Date.now() });

      return encounterData;
    } catch (error) {
      this.systemLogger.error('ProfileRecognitionOrchestrator',
        `Failed to fetch encounters for ${pubkey}: ${error}`
      );
      return null;
    }
  }

  /**
   * Sync current user's encounters from relays (overwrite local)
   */
  public async syncFromRelays(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    const encounterData = await this.fetchFromRelays(currentUser.pubkey, true);

    if (!encounterData || Object.keys(encounterData.encounters).length === 0) {
      this.systemLogger.info('ProfileRecognitionOrchestrator', 'No encounters found on relays');
      return;
    }

    // Import encounters into service (this will trigger auto-save back to file)
    // Note: We'll need to add an import method to ProfileRecognitionService
    // For now, log the intent
    this.systemLogger.info('ProfileRecognitionOrchestrator',
      `Synced from relays: ${Object.keys(encounterData.encounters).length} profiles`
    );

    // TODO: Add importEncounters() method to ProfileRecognitionService
    // that sets encounters in localStorage and triggers file save
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
   * Parse event content to extract encounters data
   */
  private parseContent(content: string): ProfileEncounterData {
    if (!content) {
      return {
        encounters: {},
        lastModified: Math.floor(Date.now() / 1000)
      };
    }

    try {
      const parsed = JSON.parse(content);
      if (parsed.version === 1 && parsed.encounters) {
        return {
          encounters: parsed.encounters,
          lastModified: Math.floor(Date.now() / 1000)
        };
      }
      return {
        encounters: {},
        lastModified: Math.floor(Date.now() / 1000)
      };
    } catch {
      return {
        encounters: {},
        lastModified: Math.floor(Date.now() / 1000)
      };
    }
  }
}
