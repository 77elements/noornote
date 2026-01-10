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

export class ZapStatsService {
  private static instance: ZapStatsService;
  private transport: NostrTransport;
  private authService: AuthService;
  private relayConfig: RelayConfig;
  private eventBus: EventBus;

  // Cache for stats per pubkey
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
   * Get zap stats for a specific pubkey (from cache)
   * Returns null if not yet loaded
   */
  public getStats(pubkey: string): ZapStats | null {
    return this.statsCache.get(pubkey) || null;
  }

  /**
   * Check if stats are currently loading
   */
  public isLoadingStats(): boolean {
    return this.isLoading;
  }

  /**
   * Load zap stats for a batch of pubkeys asynchronously
   * Emits 'zapstats:loaded' event when complete
   */
  public async loadStatsForPubkeys(pubkeys: string[]): Promise<void> {
    // If already loading, wait for existing promise
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
    const relaySet = new Set<string>();

    // Add user's configured relays
    this.relayConfig.getAllRelays().forEach(r => relaySet.add(r.url));

    // Add aggregator relays
    this.relayConfig.getAggregatorRelays().forEach(r => relaySet.add(r));

    // Add extra zap-specific relays
    EXTRA_ZAP_RELAYS.forEach(r => relaySet.add(r));

    return Array.from(relaySet);
  }

  /**
   * Fetch zap stats from combined relay list
   * Uses limit of 1500 for better coverage without overwhelming relays
   */
  private async fetchZapStats(currentUserPubkey: string, followPubkeys: string[]): Promise<void> {
    const zapRelays = this.getZapRelays();
    console.log(`[ZapStatsService] Fetching zap stats for ${followPubkeys.length} follows from ${zapRelays.length} relays...`);

    // Initialize stats for all pubkeys
    for (const pubkey of followPubkeys) {
      this.statsCache.set(pubkey, {
        pubkey,
        outgoingCount: 0,
        outgoingSats: 0,
        incomingCount: 0,
        incomingSats: 0
      });
    }

    // Set for deduplication by event ID
    const seenEventIds = new Set<string>();

    // Fetch incoming zaps (zaps TO current user)
    console.log('[ZapStatsService] Fetching incoming zaps...');
    const incomingZaps = await this.transport.fetch(zapRelays, [{
      kinds: [9735],
      '#p': [currentUserPubkey],
      limit: ZAP_QUERY_LIMIT
    }], 60000); // 60s timeout

    console.log(`[ZapStatsService] Received ${incomingZaps.length} incoming zap events`);

    // Process incoming zaps - find who zapped us
    for (const zap of incomingZaps) {
      // Skip events without ID
      if (!zap.id) continue;
      // Deduplicate by event ID
      if (seenEventIds.has(zap.id)) continue;
      seenEventIds.add(zap.id);

      const zapperPubkey = this.extractZapperPubkey(zap);
      if (zapperPubkey && followPubkeys.includes(zapperPubkey)) {
        const stats = this.statsCache.get(zapperPubkey);
        if (stats) {
          stats.incomingCount++;
          stats.incomingSats += this.parseBolt11Amount(zap);
        }
      }
    }

    // Fetch ALL outgoing zaps (zaps FROM current user)
    // Strategy: Fetch all zaps TO each follow, then filter by zapper = currentUser
    console.log('[ZapStatsService] Fetching outgoing zaps...');

    // Reset seen events for outgoing
    seenEventIds.clear();

    // Batch query - fetch zaps to all follows at once
    const BATCH_SIZE = 100;
    for (let i = 0; i < followPubkeys.length; i += BATCH_SIZE) {
      const batch = followPubkeys.slice(i, i + BATCH_SIZE);

      const outgoingZaps = await this.transport.fetch(zapRelays, [{
        kinds: [9735],
        '#p': batch,
        limit: ZAP_QUERY_LIMIT
      }], 60000); // 60s timeout

      // Process outgoing zaps - find where we are the zapper
      for (const zap of outgoingZaps) {
        // Skip events without ID
        if (!zap.id) continue;
        // Deduplicate by event ID
        if (seenEventIds.has(zap.id)) continue;
        seenEventIds.add(zap.id);

        const zapperPubkey = this.extractZapperPubkey(zap);
        if (zapperPubkey === currentUserPubkey) {
          // Find recipient from 'p' tag
          const recipientTag = zap.tags.find(t => t[0] === 'p');
          const recipientPubkey = recipientTag?.[1];

          if (recipientPubkey && this.statsCache.has(recipientPubkey)) {
            const stats = this.statsCache.get(recipientPubkey);
            if (stats) {
              stats.outgoingCount++;
              stats.outgoingSats += this.parseBolt11Amount(zap);
            }
          }
        }
      }

      // Small delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < followPubkeys.length) {
        await this.delay(300);
      }
    }

    console.log('[ZapStatsService] Zap stats fetching complete');
  }

  /**
   * Extract zapper pubkey from Kind 9735 event
   * The actual zapper is in the 'description' tag (zap request JSON)
   */
  private extractZapperPubkey(zapEvent: NostrEvent): string | null {
    try {
      const descTag = zapEvent.tags.find(t => t[0] === 'description');
      if (!descTag || !descTag[1]) return null;

      const zapRequest = JSON.parse(descTag[1]);
      return zapRequest.pubkey || null;
    } catch {
      return null;
    }
  }

  /**
   * Parse bolt11 invoice to get amount in sats
   * Based on ZapsList.parseBolt11Amount()
   */
  private parseBolt11Amount(zapEvent: NostrEvent): number {
    try {
      const bolt11Tag = zapEvent.tags.find(t => t[0] === 'bolt11');
      if (!bolt11Tag || !bolt11Tag[1]) return 0;

      const invoice = bolt11Tag[1];
      const match = invoice.match(/^ln(bc|tb)(\d+)([munp]?)/i);
      if (!match || !match[2]) return 0;

      const amount = parseInt(match[2]);
      const multiplier = match[3]?.toLowerCase();

      let millisats = 0;
      switch (multiplier) {
        case 'm': millisats = amount * 100_000_000; break;
        case 'u': millisats = amount * 100_000; break;
        case 'n': millisats = amount * 100; break;
        case 'p': millisats = amount * 0.1; break;
        default: millisats = amount * 100_000_000_000; break;
      }

      return Math.floor(millisats / 1000);
    } catch {
      return 0;
    }
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

  /**
   * Clear cache (e.g., on logout)
   */
  public clearCache(): void {
    this.statsCache.clear();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
