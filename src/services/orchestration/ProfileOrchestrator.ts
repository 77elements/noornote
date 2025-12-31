/**
 * ProfileOrchestrator - User Profile Management
 * Handles profile fetching (kind:0 metadata)
 *
 * @orchestrator ProfileOrchestrator
 * @purpose Fetch and cache user profiles
 * @used-by UserProfileService
 *
 * Architecture:
 * - Fetches kind:0 metadata events
 * - Cache: 7 days TTL (UserProfileService handles localStorage)
 * - Silent logging
 * - Batch fetching support
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { RelayConfig } from '../RelayConfig';
import { SystemLogger } from '../../components/system/SystemLogger';

export interface Profile {
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

export class ProfileOrchestrator extends Orchestrator {
  private static instance: ProfileOrchestrator;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;

  /** Profile cache (managed externally by UserProfileService) */
  private fetchingProfiles: Map<string, Promise<Profile | null>> = new Map();

  private constructor() {
    super('ProfileOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.systemLogger.info('ProfileOrchestrator', 'Initialized');
  }

  public static getInstance(): ProfileOrchestrator {
    if (!ProfileOrchestrator.instance) {
      ProfileOrchestrator.instance = new ProfileOrchestrator();
    }
    return ProfileOrchestrator.instance;
  }

  /**
   * Fetch single profile (no caching - handled by UserProfileService)
   */
  public async fetchProfile(pubkey: string): Promise<Profile | null> {
    // If already fetching, wait for that request
    if (this.fetchingProfiles.has(pubkey)) {
      return await this.fetchingProfiles.get(pubkey)!;
    }

    // Start new fetch
    const fetchPromise = this.fetchProfileFromRelays(pubkey);
    this.fetchingProfiles.set(pubkey, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.fetchingProfiles.delete(pubkey);
    }
  }

  /**
   * Fetch single profile from relays
   */
  private async fetchProfileFromRelays(pubkey: string): Promise<Profile | null> {
    // Use aggregator relays (big, fast relays) for profile fetching
    // These relays have ~99% of all profiles and respond quickly
    // User's custom relays can be slow/dead and cause timeouts
    const relays = this.relayConfig.getAggregatorRelays();

    const filters: NDKFilter[] = [{
      authors: [pubkey],
      kinds: [0],
      limit: 1
    }];

    try {
      const events = await this.transport.fetch(relays, filters, 4000);

      if (events.length === 0) {
        return null;
      }

      // Parse most recent profile metadata
      const event = events[0];
      const metadata = JSON.parse(event.content);

      // Extract multiple NIP-05 addresses from tags (Animestr-style)
      const nip05s = this.extractNip05sFromTags(event.tags);

      return {
        pubkey,
        name: metadata.name,
        display_name: metadata.display_name,
        username: metadata.username,
        picture: metadata.picture,
        about: metadata.about,
        nip05: metadata.nip05,
        nip05s: nip05s.length > 0 ? nip05s : undefined,
        lud06: metadata.lud06,
        lud16: metadata.lud16,
        website: metadata.website,
        banner: metadata.banner,
        lastUpdated: Date.now()
      };
    } catch (error) {
      this.systemLogger.error('ProfileOrchestrator', `Fetch profile failed for ${pubkey.slice(0, 8)}: ${error}`);
      return null;
    }
  }

  /**
   * Fetch multiple profiles in batch
   */
  public async fetchMultipleProfiles(pubkeys: string[]): Promise<Map<string, Profile>> {
    // Use aggregator relays (big, fast relays) for profile fetching
    const relays = this.relayConfig.getAggregatorRelays();
    const profiles = new Map<string, Profile>();

    const filters: NDKFilter[] = [{
      authors: pubkeys,
      kinds: [0]
    }];

    try {
      const events = await this.transport.fetch(relays, filters, 5000);

      // Group events by pubkey, keep most recent
      const latestEvents = new Map<string, NostrEvent>();
      events.forEach(event => {
        const existing = latestEvents.get(event.pubkey);
        if (!existing || event.created_at > existing.created_at) {
          latestEvents.set(event.pubkey, event);
        }
      });

      // Parse profiles
      latestEvents.forEach((event, pubkey) => {
        try {
          const metadata = JSON.parse(event.content);
          // Extract multiple NIP-05 addresses from tags (Animestr-style)
          const nip05s = this.extractNip05sFromTags(event.tags);
          profiles.set(pubkey, {
            pubkey,
            name: metadata.name,
            display_name: metadata.display_name,
            username: metadata.username,
            picture: metadata.picture,
            about: metadata.about,
            nip05: metadata.nip05,
            nip05s: nip05s.length > 0 ? nip05s : undefined,
            lud06: metadata.lud06,
            lud16: metadata.lud16,
            website: metadata.website,
            banner: metadata.banner,
            lastUpdated: Date.now()
          });
        } catch (error) {
          this.systemLogger.error('ProfileOrchestrator', `Parse error for ${pubkey.slice(0, 8)}: ${error}`);
        }
      });

      return profiles;
    } catch (error) {
      this.systemLogger.error('ProfileOrchestrator', `Batch fetch failed: ${error}`);
      return profiles;
    }
  }

  /**
   * Fetch oldest event from user (for "Joined Nostr" date)
   * Fetches kind:1 text notes and returns the oldest one
   *
   * @param pubkey - User's public key
   * @returns Timestamp of oldest event, or null if no events found
   */
  public async fetchOldestEvent(pubkey: string): Promise<number | null> {
    const relays = this.relayConfig.getReadRelays();

    const filters: NDKFilter[] = [{
      authors: [pubkey],
      kinds: [1], // Text notes
      since: 0,   // From epoch
      limit: 5000 // Should cover 99% of users (Nostr started late 2022)
    }];

    try {
      const events = await this.transport.fetch(relays, filters, 8000);

      if (events.length === 0) {
        return null;
      }

      // Find event with smallest created_at timestamp
      const oldest = events.reduce((min, event) =>
        event.created_at < min.created_at ? event : min
      );

      return oldest.created_at;
    } catch (error) {
      this.systemLogger.error('ProfileOrchestrator', `Fetch oldest event failed for ${pubkey.slice(0, 8)}: ${error}`);
      return null;
    }
  }

  /**
   * Extract all NIP-05 addresses from event tags (Animestr-style)
   * Tags format: ["nip05", "user@domain.com"]
   */
  private extractNip05sFromTags(tags: string[][] | undefined): string[] {
    if (!tags || !Array.isArray(tags)) return [];

    return tags
      .filter(tag => tag[0] === 'nip05' && tag[1])
      .map(tag => tag[1]);
  }

  // Orchestrator interface implementations (unused for now, required by base class)

  public onui(_data: any): void {
    // Handle UI actions (future: profile update subscriptions)
  }

  public onopen(_relay: string): void {
    // Silent operation
  }

  public onmessage(_relay: string, _event: NostrEvent): void {
    // Handle incoming events from subscriptions (future: live profile updates)
  }

  public onerror(relay: string, error: Error): void {
    this.systemLogger.error('ProfileOrchestrator', `Relay error (${relay}): ${error.message}`);
  }

  public onclose(_relay: string): void {
    // Silent operation
  }

  public override destroy(): void {
    this.fetchingProfiles.clear();
    super.destroy();
    this.systemLogger.info('ProfileOrchestrator', 'Destroyed');
  }
}
