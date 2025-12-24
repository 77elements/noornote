/**
 * FollowerCountService
 * Fetches follower counts sequentially from each relay with pagination
 *
 * @purpose Display follower counts in ProfileView
 * @pattern Sequential relay queries with pagination to overcome relay limits
 * @used-by ProfileView
 */

import { RelayConfig } from './RelayConfig';
import { SystemLogger } from '../components/system/SystemLogger';

interface BatchResult {
  followers: string[];
  oldestTimestamp: number | null;
}

export class FollowerCountService {
  private static instance: FollowerCountService;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;

  private constructor() {
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
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
   * No caching - fetches fresh data every time
   *
   * @param pubkey - User's public key
   * @param onUpdate - Callback called after each relay completes (optional)
   * @returns Final deduplicated follower count
   */
  public async getFollowerCount(
    pubkey: string,
    onUpdate?: (count: number, relay: string) => void
  ): Promise<number> {
    // Fetch from relays sequentially (no cache)
    this.systemLogger.success('FollowerCount', 'Fetching follower counts...');

    const relays = [
      ...this.relayConfig.getReadRelays(),
      ...this.relayConfig.getAggregatorRelays(),
      // 'wss://relay.nostr.band/' // Additional relay for follower discovery
    ];

    // De-duplicate relay URLs
    const uniqueRelays = [...new Set(relays)];

    this.systemLogger.info('FollowerCount', `Querying ${uniqueRelays.length} relays in parallel batches`);

    // Global follower set (deduplicated across all relays)
    const followers = new Set<string>();
    const BATCH_SIZE = 3; // Query 3 relays at once

    // Process relays in batches
    for (let i = 0; i < uniqueRelays.length; i += BATCH_SIZE) {
      const batch = uniqueRelays.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(uniqueRelays.length / BATCH_SIZE);

      this.systemLogger.info('FollowerCount', `Batch ${batchNumber}/${totalBatches}: Querying ${batch.join(', ')}...`);

      // Query all relays in batch in parallel
      const batchPromises = batch.map(async (relay) => {
        try {
          const relayFollowers = await this.queryRelayWithPagination(relay, pubkey);
          return { relay, followers: relayFollowers, success: true };
        } catch (error) {
          this.systemLogger.error('FollowerCount', `✗ ${relay} failed: ${error}`);
          return { relay, followers: [], success: false };
        }
      });

      // Wait for all relays in batch to complete
      const batchResults = await Promise.all(batchPromises);

      // Process results from batch
      batchResults.forEach(result => {
        if (result.success) {
          const previousCount = followers.size;

          // Add to global set (automatic deduplication)
          result.followers.forEach(pubkey => followers.add(pubkey));

          const currentCount = followers.size;
          const newFollowers = currentCount - previousCount;

          this.systemLogger.info(
            'FollowerCount',
            `✓ ${result.relay} returned ${result.followers.length} followers (+${newFollowers} new, ${result.followers.length - newFollowers} duplicates) → Total: ${currentCount}`
          );
        }
      });

      // Update UI after each batch completes
      if (onUpdate) {
        onUpdate(followers.size, batch[batch.length - 1]);
      }
    }

    const finalCount = followers.size;

    this.systemLogger.success('FollowerCount', `✓ Follower count fetching completed: ${finalCount} followers`);

    return finalCount;
  }

  /**
   * Query a single relay with pagination (to overcome 500 event limit)
   * Keeps fetching batches until no more events
   */
  private async queryRelayWithPagination(relayUrl: string, targetPubkey: string): Promise<string[]> {
    const allFollowers: string[] = [];
    let until: number | undefined = undefined;
    let batchCount = 0;
    const MAX_BATCHES = 20; // Safety limit (20 batches × 500 = 10000 max)

    while (batchCount < MAX_BATCHES) {
      try {
        const batch = await this.queryRelayBatch(relayUrl, targetPubkey, until);

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
        this.systemLogger.error('FollowerCount', `${relayUrl} batch ${batchCount + 1} failed: ${error}`);
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
    until?: number
  ): Promise<BatchResult> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl);
      const followers: string[] = [];
      const timestamps: number[] = [];
      const subId = Math.random().toString(36).substring(7);

      let timeout: NodeJS.Timeout;

      const cleanup = () => {
        clearTimeout(timeout);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(['CLOSE', subId]));
          ws.close();
        }
      };

      // Safety timeout (30s per batch)
      timeout = setTimeout(() => {
        cleanup();
        const oldestTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : null;
        resolve({ followers, oldestTimestamp });
      }, 30000);

      ws.onopen = () => {
        // Build filter with optional 'until' for pagination
        const filter: any = { kinds: [3], '#p': [targetPubkey] };
        if (until !== undefined) {
          filter.until = until;
        }

        ws.send(JSON.stringify(['REQ', subId, filter]));
      };

      ws.onmessage = (msg) => {
        try {
          const [type, id, event] = JSON.parse(msg.data);

          if (type === 'EVENT' && id === subId && event) {
            // Collect author pubkey (who follows the target)
            followers.push(event.pubkey);

            // Track timestamp for pagination
            if (event.created_at) {
              timestamps.push(event.created_at);
            }
          } else if (type === 'EOSE' && id === subId) {
            // End of stored events - batch is done
            cleanup();
            const oldestTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : null;
            resolve({ followers, oldestTimestamp });
          }
        } catch (error) {
          // Ignore malformed messages
        }
      };

      ws.onerror = () => {
        cleanup();
        reject(new Error('WebSocket error'));
      };

      ws.onclose = () => {
        cleanup();
        const oldestTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : null;
        resolve({ followers, oldestTimestamp });
      };
    });
  }

}
