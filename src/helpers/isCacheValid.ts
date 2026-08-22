/**
 * Check if cached item is still valid based on TTL
 * Single purpose: Object with timestamp → boolean (is valid?)
 * Generic: Works with any object that has lastUpdated timestamp
 *
 * @param item - Cached item with lastUpdated timestamp (in ms)
 * @param ttlMs - Time-to-live in milliseconds (default: 24 hours)
 * @returns true if item is still valid, false if expired or no timestamp
 *
 * @example
 * const profile = { lastUpdated: Date.now() - 1000 * 60 * 60 }; // 1 hour ago
 * isCacheValid(profile, 24 * 60 * 60 * 1000) // => true
 *
 * const oldProfile = { lastUpdated: Date.now() - 1000 * 60 * 60 * 25 }; // 25 hours ago
 * isCacheValid(oldProfile, 24 * 60 * 60 * 1000) // => false
 */

export interface CachedItem {
  lastUpdated?: number;
}

export function isCacheValid(
  item: CachedItem,
  ttlMs: number = 24 * 60 * 60 * 1000 // Default: 24 hours
): boolean {
  if (!item.lastUpdated) return false;
  return Date.now() - item.lastUpdated < ttlMs;
}
