/**
 * FollowerCountService
 * Fetches follower counts sequentially from each relay with pagination
 *
 * @purpose Display follower counts in ProfileView, and stream the follower list
 * @pattern Sequential relay queries with pagination to overcome relay limits
 * @used-by ProfileView (count), ExternalFollowListManager (list)
 */

import { RelayConfig } from './RelayConfig';
import { SystemLogger } from './SystemLogger';
import { NostrTransport } from './transport/NostrTransport';
import { LRUCache, getCacheSize } from '../helpers/LRUCache';
import type { NDKFilter } from '@nostr-dev-kit/ndk';

interface BatchResult {
  followers: string[];
  oldestTimestamp: number | null;
}

interface CachedFollowers {
  count: number;
  /** Deduplicated follower pubkeys, kept alongside the count so the followers
   *  LIST can paint instantly from cache (stale-while-revalidate) instead of
   *  re-sweeping every relay from zero on each open. */
  pubkeys: string[];
  timestamp: number;
}

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export class FollowerCountService {
  private static instance: FollowerCountService;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;
  private transport: NostrTransport;
  private cache: LRUCache<CachedFollowers> = new LRUCache<CachedFollowers>(
    getCacheSize(500, 200, 100)
  );

  private constructor() {
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.transport = NostrTransport.getInstance();
  }

  public static getInstance(): FollowerCountService {
    if (!FollowerCountService.instance) {
      FollowerCountService.instance = new FollowerCountService();
    }
    return FollowerCountService.instance;
  }

  /**
   * Get follower count for a user
   * Queries each relay sequentially with pagination, calling onUpdate after each batch
   *
   * @param pubkey - User's public key
   * @param onUpdate - Callback called after each relay batch completes (optional)
   * @returns Final deduplicated follower count
   */
  public async getFollowerCount(
    pubkey: string,
    onUpdate?: (count: number, relay: string) => void
  ): Promise<number> {
    // Check cache first
    const cached = this.cache.get(pubkey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      if (onUpdate) onUpdate(cached.count, 'cache');
      return cached.count;
    }

    this.systemLogger.success('FollowerCount', 'Fetching follower counts...');

    const followers = await this.collectFollowers(
      pubkey,
      (_newPubkeys, total, lastRelay) => {
        if (onUpdate && lastRelay) onUpdate(total, lastRelay);
      }
    );

    const finalCount = followers.length;
    this.cache.set(pubkey, {
      count: finalCount,
      pubkeys: followers,
      timestamp: Date.now(),
    });
    this.systemLogger.success(
      'FollowerCount',
      `✓ Follower count fetching completed: ${finalCount} followers`
    );

    return finalCount;
  }

  /**
   * Stream the deduplicated set of follower pubkeys.
   *
   * Stale-while-revalidate: if the count sweep already cached a pubkey set for
   * this pubkey, those pubkeys are delivered via `onBatch` IMMEDIATELY (so the
   * followers list paints at once instead of re-sweeping from zero), and a
   * fresh relay sweep only runs when the cache is stale (or `since` /
   * `forceFullRelays` require it). The follow-back button state is unaffected —
   * it comes from the user's own follow list, not this cached set — so a stale
   * cached set only risks showing who is in the list, not whether they are
   * followed back.
   *
   * `onBatch` fires with the newly discovered pubkeys after each relay batch
   * completes, so callers (e.g. the followers list) can fill progressively
   * instead of waiting for the full sweep. Resolves with the complete
   * deduplicated array and refreshes the cache on completion.
   *
   * @param pubkey - User's public key
   * @param onBatch - Called with each chunk of newly found follower pubkeys
   * @returns Final deduplicated follower pubkey array
   */
  public async streamFollowerList(
    pubkey: string,
    onBatch: (newPubkeys: string[]) => void,
    opts?: { since?: number; forceFullRelays?: boolean }
  ): Promise<string[]> {
    // SWR: paint cached pubkeys instantly. The manager dedupes via its `seen`
    // set, so pubkeys re-discovered by the revalidation sweep won't double-render.
    const cached = this.cache.get(pubkey);
    if (cached && cached.pubkeys.length > 0) {
      onBatch(cached.pubkeys.slice());
    }

    // A fresh cache with a full (non-incremental, non-forced) request needs no
    // re-sweep — the cached set is good enough and we avoid the relay round-trips.
    const fresh =
      cached !== undefined && Date.now() - cached.timestamp < CACHE_TTL_MS;
    if (fresh && opts?.since === undefined && !opts?.forceFullRelays) {
      return cached!.pubkeys;
    }

    const followers = await this.collectFollowers(
      pubkey,
      newPubkeys => {
        if (newPubkeys.length > 0) onBatch(newPubkeys);
      },
      opts?.since,
      opts?.forceFullRelays
    );

    // Only a FULL sweep (no `since`) reflects the real follower count. An incremental
    // sweep returns just the lists updated since `since`, so it must not touch the count cache.
    if (opts?.since === undefined) {
      this.cache.set(pubkey, {
        count: followers.length,
        pubkeys: followers,
        timestamp: Date.now(),
      });
    }
    return followers;
  }

  /**
   * Core relay sweep shared by count and list: query read + aggregator relays in
   * parallel batches, deduplicate followers across all relays, and report each
   * batch's newly found pubkeys via `onBatch`.
   */
  private async collectFollowers(
    pubkey: string,
    onBatch?: (
      newPubkeys: string[],
      total: number,
      lastRelay: string | undefined
    ) => void,
    since?: number,
    forceFullRelays?: boolean
  ): Promise<string[]> {
    const relays = [
      ...this.relayConfig.getReadRelays(),
      ...this.relayConfig.getAggregatorRelays(forceFullRelays),
    ];

    // De-duplicate relay URLs
    const uniqueRelays = [...new Set(relays)];

    this.systemLogger.info(
      'FollowerCount',
      `Querying ${uniqueRelays.length} relays in parallel batches`
    );

    // Global follower set (deduplicated across all relays)
    const followers = new Set<string>();
    const BATCH_SIZE = 3; // Query 3 relays at once

    // Process relays in batches
    for (let i = 0; i < uniqueRelays.length; i += BATCH_SIZE) {
      const batch = uniqueRelays.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(uniqueRelays.length / BATCH_SIZE);

      this.systemLogger.info(
        'FollowerCount',
        `Batch ${batchNumber}/${totalBatches}: Querying ${batch.join(', ')}...`
      );

      // Query all relays in batch in parallel
      const batchPromises = batch.map(async relay => {
        try {
          const relayFollowers = await this.queryRelayWithPagination(
            relay,
            pubkey,
            since
          );
          return { relay, followers: relayFollowers, success: true };
        } catch (error) {
          this.systemLogger.error(
            'FollowerCount',
            `✗ ${String(relay)} failed: ${String(error)}`
          );
          return { relay, followers: [] as string[], success: false };
        }
      });

      // Wait for all relays in batch to complete
      const batchResults = await Promise.all(batchPromises);

      // Process results from batch, tracking which pubkeys are new this batch
      const newThisBatch: string[] = [];
      batchResults.forEach(result => {
        if (result.success) {
          const previousCount = followers.size;

          result.followers.forEach(follower => {
            if (!followers.has(follower)) {
              followers.add(follower);
              newThisBatch.push(follower);
            }
          });

          const currentCount = followers.size;
          const newFollowers = currentCount - previousCount;

          this.systemLogger.info(
            'FollowerCount',
            `✓ ${result.relay} returned ${result.followers.length} followers (+${newFollowers} new, ${result.followers.length - newFollowers} duplicates) → Total: ${currentCount}`
          );
        }
      });

      // Report progress after each batch completes
      const lastRelay = batch[batch.length - 1];
      if (onBatch) onBatch(newThisBatch, followers.size, lastRelay);
    }

    return [...followers];
  }

  /**
   * Query a single relay with pagination (to overcome 500 event limit)
   * Keeps fetching batches until no more events
   */
  private async queryRelayWithPagination(
    relayUrl: string,
    targetPubkey: string,
    since?: number
  ): Promise<string[]> {
    const allFollowers: string[] = [];
    let until: number | undefined = undefined;
    let batchCount = 0;
    const MAX_BATCHES = 20; // Safety limit (20 batches × 500 = 10000 max)

    while (batchCount < MAX_BATCHES) {
      try {
        const batch = await this.queryRelayBatch(
          relayUrl,
          targetPubkey,
          until,
          since
        );

        if (batch.followers.length === 0) {
          // No more events
          break;
        }

        allFollowers.push(...batch.followers);
        batchCount++;

        // Only log batches if pagination is happening (multiple batches)
        if (batch.followers.length >= 500) {
          this.systemLogger.info(
            'FollowerCount',
            `  ↳ Batch ${batchCount}: ${batch.followers.length} events (fetching more...)`
          );
        }

        // If we got less than 500, relay has no more events
        if (batch.followers.length < 500) {
          if (batchCount > 1) {
            this.systemLogger.info(
              'FollowerCount',
              `  ↳ Batch ${batchCount}: ${batch.followers.length} events (done)`
            );
          }
          break;
        }

        // Prepare for next batch
        if (batch.oldestTimestamp !== null) {
          until = batch.oldestTimestamp;
        } else {
          // No timestamp found, can't paginate further
          break;
        }
      } catch (error) {
        this.systemLogger.error(
          'FollowerCount',
          `${String(relayUrl)} batch ${batchCount + 1} failed: ${String(error)}`
        );
        break;
      }
    }

    return allFollowers;
  }

  /**
   * Query a single batch from a relay (one REQ/EOSE cycle)
   */
  private async queryRelayBatch(
    relayUrl: string,
    targetPubkey: string,
    until?: number,
    since?: number
  ): Promise<BatchResult> {
    // Single-relay query over NDK's pooled connection (reuses the per-relay socket
    // instead of opening a fresh WebSocket per batch). NDK verifies signatures.
    const filter: NDKFilter = { kinds: [3], '#p': [targetPubkey] };
    if (until !== undefined) {
      filter.until = until;
    }
    if (since !== undefined) {
      filter.since = since;
    }

    const events = await this.transport.fetchDirect(
      [relayUrl],
      [filter],
      30000,
      'FollowerCount'
    );
    const followers = events
      .map(e => e.pubkey)
      .filter((p): p is string => typeof p === 'string');
    const timestamps = events
      .map(e => e.created_at)
      .filter((t): t is number => typeof t === 'number');
    const oldestTimestamp =
      timestamps.length > 0 ? Math.min(...timestamps) : null;
    return { followers, oldestTimestamp };
  }
}
