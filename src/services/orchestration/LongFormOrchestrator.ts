/**
 * LongFormOrchestrator - Long-form Content Management
 * Handles addressable/replaceable events (NIP-01 parameterized replaceable, kind 30000-39999)
 * Primary use: NIP-23 articles (kind 30023)
 *
 * @orchestrator LongFormOrchestrator
 * @purpose Fetch and cache long-form articles (kind 30023)
 * @used-by ArticleView, ArticlePreview components
 *
 * Architecture:
 * - Fetches kind 30023 (long-form articles)
 * - Uses coordinates: kind + pubkey + d-tag (identifier)
 * - Silent logging
 * - Multi-stage relay strategy (hint relays → standard → outbound)
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { decodeNip19 } from '../NostrToolsAdapter';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { OutboundRelaysOrchestrator } from './OutboundRelaysOrchestrator';
import { SystemLogger } from '../SystemLogger';
import { getTag } from '../../helpers/tagUtils';

export interface AddressableEventData {
  kind: number;
  pubkey: string;
  identifier: string; // d-tag
  relays?: string[];
}

export interface ArticleMetadata {
  title: string;
  image: string;
  summary: string;
  publishedAt: number;
  identifier: string;
  topics: string[];
}

export class LongFormOrchestrator extends Orchestrator {
  private static instance: LongFormOrchestrator;
  private transport: NostrTransport;
  private relayDiscovery: OutboundRelaysOrchestrator;
  private systemLogger: SystemLogger;

  /** Map naddr → event ID for addressable event lookups */
  private naddrToEventId: Map<string, string> = new Map();

  /** Track ongoing fetches to prevent duplicates */
  private fetching: Map<string, Promise<NostrEvent | null>> = new Map();

  private constructor() {
    super('LongFormOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.relayDiscovery = OutboundRelaysOrchestrator.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.systemLogger.info('LongFormOrchestrator', 'Initialized');
  }

  public static getInstance(): LongFormOrchestrator {
    if (!LongFormOrchestrator.instance) {
      LongFormOrchestrator.instance = new LongFormOrchestrator();
    }
    return LongFormOrchestrator.instance;
  }

  /**
   * Fetch addressable event from naddr reference
   */
  public async fetchAddressableEvent(
    naddrRef: string
  ): Promise<NostrEvent | null> {
    // If already fetching, wait for that request
    if (this.fetching.has(naddrRef)) {
      return this.fetching.get(naddrRef)!;
    }

    // Start new fetch
    const fetchPromise = this.fetchFromRelays(naddrRef);
    this.fetching.set(naddrRef, fetchPromise);

    try {
      const event = await fetchPromise;
      if (event && event.id) {
        // Store naddr → eventId mapping
        this.naddrToEventId.set(naddrRef, event.id);
      }
      return event;
    } finally {
      this.fetching.delete(naddrRef);
    }
  }

  /**
   * Fetch addressable event from relays
   */
  private async fetchFromRelays(naddrRef: string): Promise<NostrEvent | null> {
    // Decode naddr
    const data = this.decodeNaddr(naddrRef);
    if (!data) {
      this.systemLogger.error(
        'LongFormOrchestrator',
        `Invalid naddr: ${naddrRef.slice(0, 30)}`
      );
      return null;
    }

    // Stage 1: Try hint relays first (if provided in naddr)
    if (data.relays && data.relays.length > 0) {
      const event = await this.fetchByCoordinates(data, data.relays);
      if (event) {
        return event;
      }
    }

    // Stage 2: Try standard relays
    const standardRelays = this.transport.getReadRelays();
    const event = await this.fetchByCoordinates(data, standardRelays);
    if (event) {
      return event;
    }

    // Stage 3: Try with outbound relays
    try {
      const outboundRelays = await this.relayDiscovery.getCombinedRelays(
        [data.pubkey],
        true
      );
      return await this.fetchByCoordinates(data, outboundRelays);
    } catch (error) {
      this.systemLogger.error(
        'LongFormOrchestrator',
        `Stage 3 failed: ${error}`
      );
      return null;
    }
  }

  /**
   * Fetch addressable event by coordinates
   */
  private async fetchByCoordinates(
    data: AddressableEventData,
    relays: string[]
  ): Promise<NostrEvent | null> {
    const filters: NDKFilter[] = [
      {
        kinds: [data.kind],
        authors: [data.pubkey],
        '#d': [data.identifier],
        limit: 1,
      },
    ];

    try {
      const events = await this.transport.fetch(
        relays,
        filters,
        5000,
        false,
        'LongFormOrch'
      );
      if (events.length === 0) return null;
      // Pick the latest version by created_at. `limit: 1` is per-relay, so
      // NDK can still aggregate multiple versions from different relays
      // into the result set — `events[0]` would otherwise return whichever
      // landed first in iteration order, occasionally a stale generation.
      return events.reduce((latest, ev) =>
        ev.created_at > latest.created_at ? ev : latest
      );
    } catch {
      return null;
    }
  }

  /**
   * Decode naddr reference (NIP-19)
   */
  private decodeNaddr(naddrRef: string): AddressableEventData | null {
    try {
      // Remove nostr: prefix if present
      const cleanRef = naddrRef.replace(/^nostr:/, '');

      const decoded = decodeNip19(cleanRef);

      if (decoded.type !== 'naddr') {
        return null;
      }

      const data = decoded.data as any;

      return {
        kind: data.kind,
        pubkey: data.pubkey,
        identifier: data.identifier,
        relays: data.relays || [],
      };
    } catch {
      return null;
    }
  }

  /**
   * Extract metadata from long-form article (NIP-23)
   */
  public static extractArticleMetadata(event: NostrEvent): ArticleMetadata {
    const tags = event.tags;

    return {
      title: getTag(tags, 'title', 'Untitled Article'),
      image: getTag(tags, 'image'),
      summary: getTag(tags, 'summary'),
      publishedAt: parseInt(
        tags.find(t => t[0] === 'published_at')?.[1] || String(event.created_at)
      ),
      identifier: getTag(tags, 'd'),
      topics: tags
        .filter(t => t[0] === 't')
        .map(t => t[1])
        .filter((v): v is string => v !== undefined),
    };
  }

  /**
   * Clear cache
   */
  public clearCache(): void {
    this.naddrToEventId.clear();
    this.systemLogger.info('LongFormOrchestrator', 'Naddr mappings cleared');
  }

  // Orchestrator interface implementations

  public onui(_data: any): void {
    // Handle UI actions (future: article refresh/reload)
  }

  public onopen(_relay: string): void {
    // Silent operation
  }

  public onmessage(_relay: string, _event: NostrEvent): void {
    // Handle incoming events from subscriptions (future: live article updates)
  }

  public onerror(relay: string, error: Error): void {
    this.systemLogger.error(
      'LongFormOrchestrator',
      `Relay error (${relay}): ${error.message}`
    );
  }

  public onclose(_relay: string): void {
    // Silent operation
  }

  public override destroy(): void {
    this.naddrToEventId.clear();
    this.fetching.clear();
    super.destroy();
    this.systemLogger.info('LongFormOrchestrator', 'Destroyed');
  }
}
