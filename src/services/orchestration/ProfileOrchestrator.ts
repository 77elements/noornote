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
 * - 2-stage fetch: aggregator relays → outbound relays (NIP-65)
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { RelayConfig } from '../RelayConfig';
import { OutboundRelaysOrchestrator } from './OutboundRelaysOrchestrator';
import { SystemLogger } from '../SystemLogger';
import { diagLog } from '../DiagnosticLogger';

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
  private relayDiscovery: OutboundRelaysOrchestrator;
  private systemLogger: SystemLogger;

  /** Profile cache (managed externally by UserProfileService) */
  private fetchingProfiles: Map<string, Promise<Profile | null>> = new Map();

  private constructor() {
    super('ProfileOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.relayDiscovery = OutboundRelaysOrchestrator.getInstance();
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
   * Fetch single profile from relays (2-stage: aggregator → outbound)
   */
  private async fetchProfileFromRelays(pubkey: string): Promise<Profile | null> {
    const filters: NDKFilter[] = [{
      authors: [pubkey],
      kinds: [0],
      limit: 1
    }];

    // Stage 1: Aggregator relays (big, fast relays — have ~99% of profiles)
    const relays = this.relayConfig.getAggregatorRelays();

    try {
      const events = await this.transport.fetch(relays, filters, 4000, false, 'ProfileOrch');
      const event = events[0];
      if (event) {
        return this.parseProfileEvent(pubkey, event);
      }
    } catch {
      // Aggregator fetch failed, continue to outbound
    }

    // Stage 2: Outbound relays (NIP-65 write relays of the user)
    // skipCache=true forces relay-only fetch (bypasses NDK cache from stage 1)
    try {
      const outboundRelays = await this.relayDiscovery.getCombinedRelays([pubkey], true);
      const newRelays = outboundRelays.filter(r => !relays.includes(r));
      diagLog('relays', 'ProfileOrchestrator: stage 2 trying outbound', {
        pubkey: pubkey.slice(0, 8),
        totalRelays: outboundRelays.length,
        newRelays: newRelays.slice(0, 5)
      });

      const events = await this.transport.fetch(outboundRelays, filters, 8000, true, 'ProfileOrch');
      if (events[0]) {
        diagLog('relays', 'ProfileOrchestrator: outbound fallback found profile', { pubkey: pubkey.slice(0, 8) });
        return this.parseProfileEvent(pubkey, events[0]);
      }
      diagLog('relays', 'ProfileOrchestrator: stage 2 returned empty', { pubkey: pubkey.slice(0, 8) });
    } catch (error) {
      diagLog('relays', 'ProfileOrchestrator: stage 2 failed', { pubkey: pubkey.slice(0, 8), error: String(error) });
    }

    return null;
  }

  /**
   * Parse a kind:0 event into a Profile
   */
  private parseProfileEvent(pubkey: string, event: NostrEvent): Profile {
    const metadata = JSON.parse(event.content);
    const nip05s = this.extractNip05sFromTags(event.tags);
    return this.buildProfile(pubkey, metadata, nip05s);
  }

  /**
   * Fetch multiple profiles in batch
   * No outbound fallback here — batch fetches are for UI lists where
   * aggregator coverage is sufficient and latency matters more
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
      const events = await this.transport.fetch(relays, filters, 5000, false, 'ProfileOrch');

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
          profiles.set(pubkey, this.parseProfileEvent(pubkey, event));
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
   * Primary: Primal Cache API (pre-computed time_joined)
   * Fallback: Fetch from standard relays
   */
  public async fetchOldestEvent(pubkey: string): Promise<number | null> {
    // Try Primal Cache first (reliable, pre-computed)
    try {
      const primalResult = await this.fetchTimeJoinedFromPrimal(pubkey);
      if (primalResult) return primalResult;
    } catch {
      // Primal unavailable, fall through to relay fetch
    }

    // Fallback: fetch from standard relays
    const relays = this.relayConfig.getReadRelays();
    const filters: NDKFilter[] = [{
      authors: [pubkey],
      kinds: [1, 21, 22, 1063, 9802],
      since: 0,
      limit: 5000
    }];

    try {
      const events = await this.transport.fetch(relays, filters, 8000, false, 'ProfileOrch');
      if (events.length === 0) return null;

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
   * Query Primal Cache API for pre-computed time_joined.
   * Returns the timestamp of the user's earliest known event.
   */
  private fetchTimeJoinedFromPrimal(pubkey: string): Promise<number | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve(null);
      }, 5000);

      let ws: WebSocket;
      try {
        ws = new WebSocket('wss://cache2.primal.net/v1');
      } catch {
        clearTimeout(timeout);
        resolve(null);
        return;
      }

      ws.onopen = () => {
        ws.send(JSON.stringify(['REQ', 'joined', { cache: ['user_profile', { pubkey }] }]));
      };

      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          // Look for kind 10000105 (USER_PROFILE_INFO) which contains time_joined
          if (Array.isArray(data) && data[2]?.kind === 10000105) {
            const content = JSON.parse(data[2].content);
            if (content.time_joined && content.time_joined > 0) {
              clearTimeout(timeout);
              ws.close();
              resolve(content.time_joined);
              return;
            }
          }
        } catch {
          // Parse error, continue listening
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        ws.close();
        resolve(null);
      };
    });
  }

  /**
   * Extract all NIP-05 addresses from event tags (Animestr-style)
   * Tags format: ["nip05", "user@domain.com"]
   */
  private extractNip05sFromTags(tags: string[][] | undefined): string[] {
    if (!tags || !Array.isArray(tags)) return [];

    return tags
      .filter((tag): tag is [string, string, ...string[]] => tag[0] === 'nip05' && typeof tag[1] === 'string')
      .map(tag => tag[1]);
  }

  /**
   * Build a Profile object from metadata, ensuring proper types for exactOptionalPropertyTypes
   */
  private buildProfile(pubkey: string, metadata: Record<string, unknown>, nip05s: string[]): Profile {
    const profile: Profile = {
      pubkey,
      lastUpdated: Date.now()
    };

    if (typeof metadata.name === 'string') profile.name = metadata.name;
    if (typeof metadata.display_name === 'string') profile.display_name = metadata.display_name;
    if (typeof metadata.username === 'string') profile.username = metadata.username;
    if (typeof metadata.picture === 'string') profile.picture = metadata.picture;
    if (typeof metadata.about === 'string') profile.about = metadata.about;
    if (typeof metadata.nip05 === 'string') profile.nip05 = metadata.nip05;
    if (nip05s.length > 0) profile.nip05s = nip05s;
    if (typeof metadata.lud06 === 'string') profile.lud06 = metadata.lud06;
    if (typeof metadata.lud16 === 'string') profile.lud16 = metadata.lud16;
    if (typeof metadata.website === 'string') profile.website = metadata.website;
    if (typeof metadata.banner === 'string') profile.banner = metadata.banner;

    return profile;
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
