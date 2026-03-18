/**
 * storage.ts - Shared localStorage read/write for all lists
 *
 * Wraps PerAccountLocalStorage for per-account isolation.
 * All list data is stored per-pubkey to prevent cross-account data leaks.
 *
 * CRITICAL: Lists from Account A must NEVER appear under Account B!
 */

import { PerAccountLocalStorage, StorageKeys, type StorageKey } from '../services/PerAccountLocalStorage';

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
  const result = getStorage().get<T[]>(key, defaultValue);
  console.debug('[DIAG:storage] readList:', { key, itemCount: result.length });
  return result;
}

/**
 * Write list data to per-account localStorage
 */
export function writeList<T>(key: StorageKey, items: T[]): void {
  console.debug('[DIAG:storage] writeList:', { key, itemCount: items.length });
  getStorage().set(key, items);
}

/**
 * Clear list data from per-account localStorage
 */
export function clearList(key: StorageKey): void {
  getStorage().remove(key);
}

/**
 * Generic deduplication by a key property
 */
function deduplicateByKey<T, K extends keyof T>(items: T[], key: K): T[] {
  const map = new Map<T[K], T>();
  for (const item of items) {
    map.set(item[key], item);
  }
  return Array.from(map.values());
}

/**
 * Deduplicate items by ID
 */
export function deduplicateById<T extends { id: string }>(items: T[]): T[] {
  return deduplicateByKey(items, 'id');
}

/**
 * Deduplicate items by pubkey
 */
export function deduplicateByPubkey<T extends { pubkey: string }>(items: T[]): T[] {
  return deduplicateByKey(items, 'pubkey');
}

/**
 * Merge two arrays by key (union, browser items take priority on duplicates)
 */
export function mergeByKey<T, K extends keyof T>(browserItems: T[], newItems: T[], key: K): T[] {
  const map = new Map<T[K], T>();
  browserItems.forEach(item => map.set(item[key], item));
  newItems.forEach(item => {
    if (!map.has(item[key])) {
      map.set(item[key], item);
    }
  });
  return Array.from(map.values());
}

/**
 * Merge two string arrays (union)
 */
export function mergeStringArrays(browserItems: string[], newItems: string[]): string[] {
  const set = new Set(browserItems);
  newItems.forEach(item => set.add(item));
  return Array.from(set);
}

/**
 * Get current Unix timestamp (seconds)
 */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}
