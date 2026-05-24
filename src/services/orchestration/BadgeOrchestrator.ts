/**
 * BadgeOrchestrator — NIP-58 Badge Definition fetching + caching
 *
 * Fetches kind:30009 badge definitions by addressable coordinate
 * (`kind:pubkey:d-tag`). LRU-cached per coordinate key.
 * Used by BadgeAwardRenderer to resolve name/image/description for
 * kind:8 badge awards.
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { NostrTransport } from '../transport/NostrTransport';
import { OutboundRelaysOrchestrator } from './OutboundRelaysOrchestrator';
import { RelayConfig } from '../RelayConfig';
import { LRUCache, getCacheSize } from '../../helpers/LRUCache';

export interface BadgeDefinition {
  name: string;
  description: string;
  image: string | undefined;
  thumb: string | undefined;
  issuerPubkey: string;
  slug: string;
  rawEvent: NostrEvent;
}

export class BadgeOrchestrator {
  private static instance: BadgeOrchestrator;
  private transport: NostrTransport;
  private relayDiscovery: OutboundRelaysOrchestrator;
  private relayConfig: RelayConfig;

  private cache = new LRUCache<BadgeDefinition>(getCacheSize(200, 100, 50));
  private fetching = new Map<string, Promise<BadgeDefinition | null>>();

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.relayDiscovery = OutboundRelaysOrchestrator.getInstance();
    this.relayConfig = RelayConfig.getInstance();
  }

  public static getInstance(): BadgeOrchestrator {
    if (!BadgeOrchestrator.instance) {
      BadgeOrchestrator.instance = new BadgeOrchestrator();
    }
    return BadgeOrchestrator.instance;
  }

  /**
   * Fetch a badge definition by its addressable coordinate.
   * @param coordinate  `30009:<issuer-pubkey>:<badge-slug>`
   */
  public async fetchBadgeDefinition(coordinate: string): Promise<BadgeDefinition | null> {
    const cached = this.cache.get(coordinate);
    if (cached) return cached;

    if (this.fetching.has(coordinate)) {
      return this.fetching.get(coordinate)!;
    }

    const promise = this.fetchFromRelays(coordinate);
    this.fetching.set(coordinate, promise);
    try {
      const result = await promise;
      if (result) this.cache.set(coordinate, result);
      return result;
    } finally {
      this.fetching.delete(coordinate);
    }
  }

  private async fetchFromRelays(coordinate: string): Promise<BadgeDefinition | null> {
    const parts = coordinate.split(':');
    if (parts.length < 3) return null;

    const issuerPubkey = parts[1]!;
    const slug = parts.slice(2).join(':');

    const filter: NDKFilter = {
      kinds: [30009 as number],
      authors: [issuerPubkey],
      '#d': [slug],
      limit: 1,
    };

    // Stage 1: aggregator + own read-relays
    const baseRelays: string[] = [
      ...this.relayConfig.getReadRelays(),
      ...this.relayConfig.getAggregatorRelays(),
    ];

    let events = await this.transport.fetch(baseRelays, [filter], 5000, false, 'BadgeOrch');
    if (events[0]) return BadgeOrchestrator.parseDefinition(events[0], issuerPubkey, slug);

    // Stage 2: issuer's outbound relays
    try {
      const outbound: string[] = await this.relayDiscovery.getCombinedRelays([issuerPubkey], true);
      const newRelays = outbound.filter(r => !baseRelays.includes(r));
      if (newRelays.length > 0) {
        events = await this.transport.fetch(newRelays, [filter], 5000, true, 'BadgeOrch');
        if (events[0]) return BadgeOrchestrator.parseDefinition(events[0], issuerPubkey, slug);
      }
    } catch { /* outbound discovery failed — acceptable */ }

    return null;
  }

  private static parseDefinition(event: NostrEvent, issuerPubkey: string, slug: string): BadgeDefinition {
    const name = event.tags.find(t => t[0] === 'name')?.[1] ?? slug;
    const description = event.tags.find(t => t[0] === 'description')?.[1] ?? '';
    const image = event.tags.find(t => t[0] === 'image')?.[1] ?? undefined;
    const thumb = event.tags.find(t => t[0] === 'thumb')?.[1] ?? undefined;
    return { name, description, image, thumb, issuerPubkey, slug, rawEvent: event };
  }
}
