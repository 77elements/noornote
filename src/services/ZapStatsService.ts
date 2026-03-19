/**
 * ZapStatsService - Track zap statistics between users
 * Fetches zap receipts (Kind 9735) and calculates outgoing/incoming stats
 * Used by FollowListSecondaryManager for zap reciprocity display
 *
 * @purpose Track zap exchanges between current user and follows
 * @used-by FollowListSecondaryManager
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { NostrTransport } from './transport/NostrTransport';
import { AuthService } from './AuthService';
import { RelayConfig } from './RelayConfig';
import { EventBus } from './EventBus';
import { extractZapperPubkey, getZapAmountSats } from '../helpers/zapUtils';

export interface ZapStats {
  pubkey: string;
  outgoingCount: number;
  outgoingSats: number;
  incomingCount: number;
  incomingSats: number;
}

// Additional zap-specific relays (beyond aggregators)
const EXTRA_ZAP_RELAYS = [
  'wss://purplepag.es',
];

// Limit for zap queries (balanced for performance)
const ZAP_QUERY_LIMIT = 800;

// Batch size for outgoing zap queries
const BATCH_SIZE = 100;

// Delay between batches to avoid rate limiting (ms)
const BATCH_DELAY_MS = 300;

// Timeout for zap relay fetches (ms)
const FETCH_TIMEOUT_MS = 60000;

export class ZapStatsService {
  private static instance: ZapStatsService;
  private transport: NostrTransport;
  private authService: AuthService;
  private relayConfig: RelayConfig;
  private eventBus: EventBus;

  private statsCache: Map<string, ZapStats> = new Map();
  private isLoading: boolean = false;
  private loadingPromise: Promise<void> | null = null;

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.authService = AuthService.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.eventBus = EventBus.getInstance();
  }

  public static getInstance(): ZapStatsService {
    if (!ZapStatsService.instance) {
      ZapStatsService.instance = new ZapStatsService();
    }
    return ZapStatsService.instance;
  }

  /**
   * Get zap stats for a specific pubkey (from cache).
   * Returns null if not yet loaded.
   */
  public getStats(pubkey: string): ZapStats | null {
    return this.statsCache.get(pubkey) || null;
  }

  public isLoadingStats(): boolean {
    return this.isLoading;
  }

  /**
   * Load zap stats for a batch of pubkeys asynchronously.
   * Emits 'zapstats:loaded' event when complete.
   */
  public async loadStatsForPubkeys(pubkeys: string[]): Promise<void> {
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser || pubkeys.length === 0) return;

    this.isLoading = true;

    this.loadingPromise = this.fetchZapStats(currentUser.pubkey, pubkeys)
      .then(() => {
        this.eventBus.emit('zapstats:loaded', {});
      })
      .catch(error => {
        console.error('[ZapStatsService] Failed to load zap stats:', error);
      })
      .finally(() => {
        this.isLoading = false;
        this.loadingPromise = null;
      });

    return this.loadingPromise;
  }

  /**
   * Build combined relay list: user relays + aggregator relays + extra zap relays
   */
  private getZapRelays(): string[] {
    const relaySet = new Set<string>([
      ...this.relayConfig.getAllRelays().map(r => r.url),
      ...this.relayConfig.getAggregatorRelays(),
      ...EXTRA_ZAP_RELAYS
    ]);
    return Array.from(relaySet);
  }

  /**
   * Initialize empty stats entries for all follow pubkeys
   */
  private initializeStatsCache(pubkeys: string[]): void {
    for (const pubkey of pubkeys) {
      this.statsCache.set(pubkey, {
        pubkey,
        outgoingCount: 0,
        outgoingSats: 0,
        incomingCount: 0,
        incomingSats: 0
      });
    }
  }

  /**
   * Process a batch of zap events, deduplicating by event ID.
   * Calls the handler for each unique event.
   */
  private processZapEvents(
    events: NostrEvent[],
    seenIds: Set<string>,
    handler: (event: NostrEvent) => void
  ): void {
    for (const event of events) {
      if (!event.id || seenIds.has(event.id)) continue;
      seenIds.add(event.id);
      handler(event);
    }
  }

  /**
   * Fetch zap stats from combined relay list
   */
  private async fetchZapStats(currentUserPubkey: string, followPubkeys: string[]): Promise<void> {
    const zapRelays = this.getZapRelays();
    console.log(`[ZapStatsService] Fetching zap stats for ${followPubkeys.length} follows from ${zapRelays.length} relays...`);

    this.initializeStatsCache(followPubkeys);
    const followSet = new Set(followPubkeys);
    const seenEventIds = new Set<string>();

    // Fetch incoming zaps (zaps TO current user)
    console.log('[ZapStatsService] Fetching incoming zaps...');
    const incomingZaps = await this.transport.fetch(zapRelays, [{
      kinds: [9735],
      '#p': [currentUserPubkey],
      limit: ZAP_QUERY_LIMIT
    }], FETCH_TIMEOUT_MS, false, 'ZapStatsService');

    console.log(`[ZapStatsService] Received ${incomingZaps.length} incoming zap events`);

    this.processZapEvents(incomingZaps, seenEventIds, (zap) => {
      const zapperPubkey = extractZapperPubkey(zap);
      if (!followSet.has(zapperPubkey)) return;

      const stats = this.statsCache.get(zapperPubkey);
      if (stats) {
        stats.incomingCount++;
        stats.incomingSats += getZapAmountSats(zap);
      }
    });

    // Fetch outgoing zaps (zaps FROM current user to follows, in batches)
    console.log('[ZapStatsService] Fetching outgoing zaps...');
    seenEventIds.clear();

    for (let i = 0; i < followPubkeys.length; i += BATCH_SIZE) {
      const batch = followPubkeys.slice(i, i + BATCH_SIZE);

      const outgoingZaps = await this.transport.fetch(zapRelays, [{
        kinds: [9735],
        '#p': batch,
        limit: ZAP_QUERY_LIMIT
      }], FETCH_TIMEOUT_MS, false, 'ZapStatsService');

      this.processZapEvents(outgoingZaps, seenEventIds, (zap) => {
        if (extractZapperPubkey(zap) !== currentUserPubkey) return;

        const recipientPubkey = zap.tags.find(t => t[0] === 'p')?.[1];
        if (!recipientPubkey) return;

        const stats = this.statsCache.get(recipientPubkey);
        if (stats) {
          stats.outgoingCount++;
          stats.outgoingSats += getZapAmountSats(zap);
        }
      });

      // Small delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < followPubkeys.length) {
        await this.delay(BATCH_DELAY_MS);
      }
    }

    console.log('[ZapStatsService] Zap stats fetching complete');
  }

  /**
   * Format sats for display (e.g., 1500 -> "1.5k", 150000 -> "150k")
   */
  public formatSats(sats: number): string {
    if (sats >= 1_000_000) {
      return (sats / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    }
    if (sats >= 1_000) {
      return (sats / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
    }
    return sats.toString();
  }

  public clearCache(): void {
    this.statsCache.clear();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
