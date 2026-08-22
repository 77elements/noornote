/**
 * Clean old cache entries based on TTL
 * Single purpose: Remove expired items from Map cache
 * Generic: Works with any Map<string, CachedItem> where items have lastUpdated
 *
 * @param cache - Map cache to clean
 * @param ttlMs - Time-to-live in milliseconds (default: 7 days)
 * @returns Number of entries removed
 *
 * @example
 * const cache = new Map([
 *   ['key1', { lastUpdated: Date.now() - 1000 * 60 * 60 * 24 * 8 }], // 8 days old
 *   ['key2', { lastUpdated: Date.now() }] // fresh
 * ]);
 * const removed = cleanOldCacheEntries(cache, 7 * 24 * 60 * 60 * 1000);
 * // => 1 (removed key1)
 * // cache now only has key2
 */

export interface CachedItem {
  lastUpdated?: number;
}

export function cleanOldCacheEntries<T extends CachedItem>(
  cache: Map<string, T>,
  ttlMs: number = 7 * 24 * 60 * 60 * 1000 // Default: 7 days
): number {
  const cutoff = Date.now() - ttlMs;
  let removedCount = 0;

  cache.forEach((item, key) => {
    if (item.lastUpdated && item.lastUpdated < cutoff) {
      cache.delete(key);
      removedCount++;
    }
  });

  return removedCount;
}
