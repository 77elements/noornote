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
    this.systemLogger.info('FollowerCount', 'Fetching follower counts...');

    const relays = [
      ...this.relayConfig.getReadRelays(),
      ...this.relayConfig.getAggregatorRelays(),
      // 'wss://relay.nostr.band/' // Additional relay for follower discovery
    ];

    // De-duplicate relay URLs
    const uniqueRelays = [...new Set(relays)];

    this.systemLogger.info('FollowerCount', `Querying ${uniqueRelays.length} relays`);

    // Global follower set (deduplicated across all relays)
    const followers = new Set<string>();
    let relayIndex = 0;

    // Query each relay sequentially (with pagination)
    for (const relay of uniqueRelays) {
      relayIndex++;
      const previousCount = followers.size;

      try {
        this.systemLogger.info('FollowerCount', `[${relayIndex}/${uniqueRelays.length}] Fetching from ${relay}...`);

        const relayFollowers = await this.queryRelayWithPagination(relay, pubkey);

        // Add to global set (automatic deduplication)
        relayFollowers.forEach(pubkey => followers.add(pubkey));

        const currentCount = followers.size;
        const newFollowers = currentCount - previousCount;

        this.systemLogger.info(
          'FollowerCount',
          `[${relayIndex}/${uniqueRelays.length}] ✓ ${relay} returned ${relayFollowers.length} followers (+${newFollowers} new, ${relayFollowers.length - newFollowers} duplicates) → Total: ${currentCount}`
        );

        // Update UI after each relay
        if (onUpdate) {
          onUpdate(currentCount, relay);
        }

      } catch (error) {
        this.systemLogger.error('FollowerCount', `[${relayIndex}/${uniqueRelays.length}] ✗ ${relay} failed: ${error}`);
        // Continue with next relay
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
