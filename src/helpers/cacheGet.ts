/**
 * Get value from cache
 * Single purpose: generic cache retrieval
 * Type-agnostic - works with any Map<string, T>
 */

export function cacheGet<T>(cache: Map<string, T>, key: string): T | null {
  return cache.get(key) || null;
}
