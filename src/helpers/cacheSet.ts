/**
 * Set value in cache
 * Single purpose: generic cache storage
 * Type-agnostic - works with any Map<string, T>
 */

export function cacheSet<T>(
  cache: Map<string, T>,
  key: string,
  value: T
): void {
  cache.set(key, value);
}
