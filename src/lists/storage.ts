/**
 * storage.ts - Shared localStorage read/write for all lists
 *
 * Wraps PerAccountLocalStorage for per-account isolation.
 * All list data is stored per-pubkey to prevent cross-account data leaks.
 *
 * CRITICAL: Lists from Account A must NEVER appear under Account B!
 */

import { PerAccountLocalStorage, StorageKeys, type StorageKey } from '../services/PerAccountLocalStorage';

// Re-export StorageKeys for convenience
export { StorageKeys };

/**
 * Get per-account storage instance
 */
export function getStorage(): PerAccountLocalStorage {
  return PerAccountLocalStorage.getInstance();
}

/**
 * Read list data from per-account localStorage
 */
export function readList<T>(key: StorageKey, defaultValue: T[] = []): T[] {
  return getStorage().get<T[]>(key, defaultValue);
}

/**
 * Write list data to per-account localStorage
 */
export function writeList<T>(key: StorageKey, items: T[]): void {
  getStorage().set(key, items);
}

/**
 * Clear list data from per-account localStorage
 */
export function clearList(key: StorageKey): void {
  getStorage().remove(key);
}

/**
 * Deduplicate items by ID
 */
export function deduplicateById<T extends { id: string }>(items: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return Array.from(map.values());
}

/**
 * Deduplicate items by pubkey
 */
export function deduplicateByPubkey<T extends { pubkey: string }>(items: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(item.pubkey, item);
  }
  return Array.from(map.values());
}

/**
 * Get current Unix timestamp (seconds)
 */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}
