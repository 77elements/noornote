/**
 * Single fetch source for a profile's showcase carousels (articles/videos/
 * listings): one batched round-trip across read + aggregator + outbound relays
 * (read-relays-only previously hid content on the author's write relays), split
 * by kind, cached per pubkey + in-flight-deduped so the 3 lazy carousels share
 * one fetch.
 *
 * @used-by ProfileArticlesCarousel, ProfileVideosCarousel, ProfileListingsCarousel
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { OutboundRelaysOrchestrator } from './OutboundRelaysOrchestrator';
import { RelayConfig } from '../RelayConfig';
import { AuthService } from '../AuthService';
import { LRUCache, getCacheSize } from '../../helpers/LRUCache';

export interface ProfileCarouselContent {
  /** kind 30023 long-form, plus 30024 drafts when viewing your OWN profile */
  articles: NostrEvent[];
  /** kind 21 / 22 video events */
  videos: NostrEvent[];
  /** kind 30402 NIP-99 classified listings */
  listings: NostrEvent[];
  /** kind 5 deletions by this author — for addressable tombstone filtering */
  deletions: NostrEvent[];
}

export class ProfileCarouselOrchestrator extends Orchestrator {
  private static instance: ProfileCarouselOrchestrator;
  private transport: NostrTransport;
  private relayDiscovery: OutboundRelaysOrchestrator;
  private relayConfig: RelayConfig;

  /** Cache TTL: 2 minutes (a profile's showcase content changes rarely) */
  private readonly CACHE_TTL = 2 * 60 * 1000;
  private cache = new LRUCache<ProfileCarouselContent>(getCacheSize(20, 15, 10), this.CACHE_TTL);
  private inFlight = new Map<string, Promise<ProfileCarouselContent>>();

  private constructor() {
    super('ProfileCarouselOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.relayDiscovery = OutboundRelaysOrchestrator.getInstance();
    this.relayConfig = RelayConfig.getInstance();
  }

  public static getInstance(): ProfileCarouselOrchestrator {
    if (!ProfileCarouselOrchestrator.instance) {
      ProfileCarouselOrchestrator.instance = new ProfileCarouselOrchestrator();
    }
    return ProfileCarouselOrchestrator.instance;
  }

  /**
   * Fetch a profile's carousel content. Cached per pubkey; concurrent callers
   * share one fetch. Drafts (kind 30024) are only requested for your own
   * profile. Keyed by pubkey alone (own-vs-foreign is derived here), so all
   * carousels of the same profile hit the same cache entry.
   */
  public async fetchProfileContent(pubkey: string): Promise<ProfileCarouselContent> {
    const cached = this.cache.get(pubkey);
    if (cached) return cached;

    const inflight = this.inFlight.get(pubkey);
    if (inflight) return inflight;

    const promise = this.doFetch(pubkey);
    this.inFlight.set(pubkey, promise);
    try {
      const result = await promise;
      this.cache.set(pubkey, result);
      return result;
    } finally {
      this.inFlight.delete(pubkey);
    }
  }

  /** Drop the cached entry for a pubkey (e.g. after the user publishes). */
  public invalidate(pubkey: string): void {
    this.cache.delete(pubkey);
  }

  /**
   * Drop the current user's cached carousel content. Call after the user
   * publishes an article / video / listing so their own profile shows it
   * immediately instead of waiting out the cache TTL.
   */
  public invalidateForCurrentUser(): void {
    const pubkey = AuthService.getInstance().getCurrentUser()?.pubkey;
    if (pubkey) this.cache.delete(pubkey);
  }

  private async doFetch(pubkey: string): Promise<ProfileCarouselContent> {
    const baseRelays: string[] = [
      ...this.relayConfig.getReadRelays(),
      ...this.relayConfig.getAggregatorRelays(),
    ];

    // Broaden to the author's outbound (NIP-65) relays so content that only
    // lives on their write relays still surfaces. Falls back to base relays.
    let relays = baseRelays;
    try {
      const outbound = await this.relayDiscovery.getCombinedRelays([pubkey], true);
      relays = [...new Set([...baseRelays, ...outbound])];
    } catch { /* base relays only */ }

    const includeDrafts = AuthService.getInstance().isCurrentUser(pubkey);
    const articleKinds = includeDrafts ? [30023, 30024] : [30023];

    const filters: NDKFilter[] = [
      { kinds: articleKinds as number[], authors: [pubkey], limit: 50 },
      { kinds: [21, 22], authors: [pubkey], limit: 50 },
      { kinds: [30402], authors: [pubkey], limit: 50 },
      { kinds: [5], authors: [pubkey], limit: 100 },
    ];

    const content: ProfileCarouselContent = { articles: [], videos: [], listings: [], deletions: [] };

    // Use fetchDirect (raw WS, no NDK cache/outbox layer). NDK's fetchEvents
    // pollutes/over-dedupes single-author addressable feeds and was silently
    // dropping older long-form articles that DO exist on the queried relays
    // (same reason ProfileView itself uses fetchDirect for the profile timeline).
    let events: NostrEvent[];
    try {
      events = await this.transport.fetchDirect(relays, filters, 8000, 'ProfileCarousel', /* waitForAll */ true);
    } catch {
      return content;
    }

    for (const ev of events) {
      switch (ev.kind) {
        case 30023:
        case 30024: content.articles.push(ev); break;
        case 21:
        case 22: content.videos.push(ev); break;
        case 30402: content.listings.push(ev); break;
        case 5: content.deletions.push(ev); break;
      }
    }
    return content;
  }

  // Fetch-only orchestrator — no live subscription handlers needed.
  public onui(_data: any): void { /* unused */ }
  public onopen(_relay: string): void { /* unused */ }
  public onmessage(_relay: string, _event: NostrEvent): void { /* unused */ }
  public onerror(_relay: string, _error: Error): void { /* unused */ }
  public onclose(_relay: string): void { /* unused */ }

  public override destroy(): void {
    this.cache.clear();
    this.inFlight.clear();
    super.destroy();
  }
}
