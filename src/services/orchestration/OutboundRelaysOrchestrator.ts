/**
 * OutboundRelaysOrchestrator - NIP-65 Multi-User Relay Discovery
 * Fetches relay lists from multiple users to discover "outbound relays"
 * for improved timeline diversity and content discovery
 *
 * @orchestrator OutboundRelaysOrchestrator
 * @purpose Discover additional relays from user's following list
 * @used-by FeedOrchestrator, QuoteOrchestrator, LongFormOrchestrator
 *
 * Architecture:
 * - Fetches kind:10002 relay lists for multiple users (following list)
 * - Aggregates write relays (where users publish content)
 * - Quality filtering to avoid local/test relays
 * - 1-hour cache TTL (relay lists don't change frequently)
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { RelayConfig } from '../RelayConfig';
import { SystemLogger } from '../../components/system/SystemLogger';

export interface UserRelayList {
  pubkey: string;
  writeRelays: string[];
  readRelays: string[];
  lastUpdated: number;
}

export interface RelayDiscoveryStats {
  totalUsers: number;
  discoveredRelays: number;
  cacheHits: number;
  cacheMisses: number;
}

export class OutboundRelaysOrchestrator extends Orchestrator {
  private static instance: OutboundRelaysOrchestrator;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;
  private relayListCache: Map<string, UserRelayList> = new Map();
  private stats: RelayDiscoveryStats = {
    totalUsers: 0,
    discoveredRelays: 0,
    cacheHits: 0,
    cacheMisses: 0
  };

  private readonly CACHE_TTL = 60 * 60 * 1000;
  private readonly LOG_TAG = 'OutboundRelaysOrchestrator';

  private constructor() {
    super('OutboundRelaysOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.systemLogger.info(this.LOG_TAG, 'Initialized');
  }

  public static getInstance(): OutboundRelaysOrchestrator {
    if (!OutboundRelaysOrchestrator.instance) {
      OutboundRelaysOrchestrator.instance = new OutboundRelaysOrchestrator();
    }
    return OutboundRelaysOrchestrator.instance;
  }

  public async discoverUserRelays(pubkeys: string[]): Promise<UserRelayList[]> {
    const baseRelays = this.relayConfig.getAggregatorRelays();
    const results: UserRelayList[] = [];
    const uncachedPubkeys: string[] = [];

    this.systemLogger.info(this.LOG_TAG, `Fetching relay lists for ${pubkeys.length} users`);

    for (const pubkey of pubkeys) {
      const cached = this.getCachedRelayList(pubkey);
      if (cached) {
        results.push(cached);
        this.stats.cacheHits++;
      } else {
        uncachedPubkeys.push(pubkey);
        this.stats.cacheMisses++;
      }
    }

    if (uncachedPubkeys.length === 0) {
      this.systemLogger.info(this.LOG_TAG, 'All relay lists found in cache');
      return results;
    }

    this.systemLogger.info(this.LOG_TAG, `Fetching ${uncachedPubkeys.length} uncached users`);

    const filter: NDKFilter = {
      authors: uncachedPubkeys,
      kinds: [10002],
      limit: uncachedPubkeys.length * 2
    };

    try {
      const events = await this.transport.fetch(baseRelays, [filter], 5000, false, 'OutboundOrch');
      this.systemLogger.info(this.LOG_TAG, `Received ${events.length} relay list events`);

      const processedPubkeys = new Set<string>();

      for (const event of events) {
        if (processedPubkeys.has(event.pubkey)) continue;

        const relayList = this.parseRelayListEvent(event);
        if (relayList) {
          results.push(relayList);
          this.cacheRelayList(relayList);
          processedPubkeys.add(event.pubkey);
        }
      }

      const aggregatorRelays = this.relayConfig.getAggregatorRelays();
      for (const pubkey of uncachedPubkeys) {
        if (!processedPubkeys.has(pubkey)) {
          const defaultRelayList: UserRelayList = {
            pubkey,
            writeRelays: aggregatorRelays,
            readRelays: aggregatorRelays,
            lastUpdated: Date.now()
          };
          results.push(defaultRelayList);
          this.cacheRelayList(defaultRelayList);
        }
      }

      this.stats.totalUsers = pubkeys.length;
      this.stats.discoveredRelays = results.reduce(
        (sum, list) => sum + list.writeRelays.length + list.readRelays.length,
        0
      );
    } catch (error) {
      this.systemLogger.error(this.LOG_TAG, `Fetch relay lists error: ${error}`);
    }

    return results;
  }

  public getOutboundRelays(userRelayLists: UserRelayList[]): string[] {
    const outboundRelays = new Set<string>();
    const baseRelays = new Set(this.relayConfig.getReadRelays());

    for (const relayList of userRelayLists) {
      for (const relay of relayList.writeRelays) {
        if (this.isValidRelay(relay) && !baseRelays.has(relay) && this.isQualityRelay(relay)) {
          outboundRelays.add(relay);
        }
      }
    }

    const result = Array.from(outboundRelays);
    this.systemLogger.info(this.LOG_TAG, `Discovered ${result.length} quality outbound relays from ${userRelayLists.length} users`);

    return result;
  }

  public async getCombinedRelays(pubkeys: string[], includeOutbound: boolean = true): Promise<string[]> {
    const standardRelays = this.relayConfig.getReadRelays();

    if (!includeOutbound) {
      this.systemLogger.info(this.LOG_TAG, `Using ${standardRelays.length} standard relays`);
      return standardRelays;
    }

    try {
      const relayLists = await this.discoverUserRelays(pubkeys);
      const outboundRelays = this.getOutboundRelays(relayLists);
      const aggregatorRelays = this.relayConfig.getAggregatorRelays();

      const combined = [...new Set([...standardRelays, ...outboundRelays, ...aggregatorRelays])];

      this.systemLogger.info(this.LOG_TAG, `${standardRelays.length} own + ${outboundRelays.length} author's + ${aggregatorRelays.length} aggregator = ${combined.length} total`);
      return combined;
    } catch (error) {
      this.systemLogger.error(this.LOG_TAG, `Discovery failed, using standard relays: ${error}`);
      return standardRelays;
    }
  }

  private parseRelayListEvent(event: NostrEvent): UserRelayList | null {
    try {
      const writeRelays: string[] = [];
      const readRelays: string[] = [];

      for (const tag of event.tags) {
        if (tag[0] === 'r' && tag[1]) {
          const relayUrl = tag[1];
          const marker = tag[2];

          if (!marker) {
            writeRelays.push(relayUrl);
            readRelays.push(relayUrl);
          } else if (marker === 'write') {
            writeRelays.push(relayUrl);
          } else if (marker === 'read') {
            readRelays.push(relayUrl);
          }
        }
      }

      return {
        pubkey: event.pubkey,
        writeRelays: [...new Set(writeRelays)],
        readRelays: [...new Set(readRelays)],
        lastUpdated: Date.now()
      };
    } catch (error) {
      this.systemLogger.error(this.LOG_TAG, `Parse relay list event error: ${error}`);
      return null;
    }
  }

  private getCachedRelayList(pubkey: string): UserRelayList | null {
    const cached = this.relayListCache.get(pubkey);
    if (cached && Date.now() - cached.lastUpdated < this.CACHE_TTL) {
      return cached;
    }
    if (cached) {
      this.relayListCache.delete(pubkey);
    }
    return null;
  }

  private cacheRelayList(relayList: UserRelayList): void {
    this.relayListCache.set(relayList.pubkey, relayList);
  }

  private isValidRelay(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'wss:' || parsed.protocol === 'ws:';
    } catch {
      return false;
    }
  }

  private getHostname(url: string): string | null {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  private isKnownRelay(hostname: string, relayUrls: string[]): boolean {
    return relayUrls.some(relay => this.getHostname(relay) === hostname);
  }

  private isQualityRelay(url: string): boolean {
    const hostname = this.getHostname(url);
    if (!hostname) return false;

    const configuredRelays = this.relayConfig.getAllRelays().map(r => r.url);
    if (this.isKnownRelay(hostname, configuredRelays)) return true;

    const aggregatorRelays = this.relayConfig.getAggregatorRelays();
    if (this.isKnownRelay(hostname, aggregatorRelays)) return true;

    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.includes('.local') ||
      hostname.startsWith('test.') ||
      hostname.startsWith('dev.') ||
      hostname.startsWith('staging.')
    ) {
      return false;
    }

    return hostname.includes('.') && hostname.length > 4;
  }

  public getStats(): RelayDiscoveryStats {
    return { ...this.stats };
  }

  public clearCache(): void {
    this.relayListCache.clear();
    this.systemLogger.info(this.LOG_TAG, 'Cache cleared');
  }

  public getCacheStatus(): { size: number; ttl: number } {
    return { size: this.relayListCache.size, ttl: this.CACHE_TTL };
  }

  public onui(): void {}
  public onopen(): void {}
  public onmessage(): void {}
  public onclose(): void {}

  public onerror(relay: string, error: Error): void {
    this.systemLogger.error(this.LOG_TAG, `Relay error (${relay}): ${error.message}`);
  }

  public override destroy(): void {
    this.relayListCache.clear();
    super.destroy();
    this.systemLogger.info(this.LOG_TAG, 'Destroyed');
  }
}
