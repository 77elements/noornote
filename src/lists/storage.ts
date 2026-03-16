/**
 * storage.ts - Shared localStorage read/write for all lists
 *
 * Wraps PerAccountLocalStorage for per-account isolation.
 * All list data is stored per-pubkey to prevent cross-account data leaks.
 *
 * CRITICAL: Lists from Account A must NEVER appear under Account B!
 */

import { PerAccountLocalStorage, StorageKeys, type StorageKey } from '../services/PerAccountLocalStorage';
import { diagLog } from '../services/DiagnosticLogger';

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
  diagLog('lists', 'readList', { key, itemCount: result.length });
  return result;
}

/**
 * Write list data to per-account localStorage
 */
export function writeList<T>(key: StorageKey, items: T[]): void {
  diagLog('lists', 'writeList', { key, itemCount: items.length });
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

/**
 * Sync action classification.
 *
 * Central decision: does a sync diff require user confirmation (modal) or can it be auto-applied?
 *
 * AUTO cases (no modal):
 *  - Only new items from relay (added > 0, removed = 0, moved = 0)
 *  - Only property changes (isPrivate, description)
 *  - Only order changes (folder order, item order)
 *  - Only new folders from relay (with new items)
 *  - Any combination of the above
 *
 * MODAL cases (user must decide):
 *  - Items only in browser (removed > 0) — could be locally added or relay-deleted
 *  - Folders only in browser (hasFolderSetDiff with onlyInBrowser) — could be locally created or relay-deleted
 *  - Items in different folders (moved > 0)
 *  - Any combination containing one of the above
 *
 * SKIP cases:
 *  - No differences at all
 *  - Relay returned empty (safety)
 */
export type SyncAction = 'auto' | 'modal' | 'skip';

export interface SyncDiffInput {
  added: number;
  removed: number;
  moved: number;
  requiresConfirmation: boolean;
  relayContentWasEmpty: boolean;
  snapshotDiffInfo?: {
    isOrderOnly: boolean;
    hasFolderSetDiff: boolean;
  } | undefined;
}

export function classifySyncAction(diff: SyncDiffInput): SyncAction {
  // No differences
  if (!diff.requiresConfirmation && diff.added === 0 && diff.removed === 0 && diff.moved === 0) {
    return 'skip';
  }

  // Relay returned empty but we'd remove items — unsafe
  if (diff.relayContentWasEmpty && diff.removed > 0) {
    return 'skip';
  }

  // Items removed or moved → user must decide
  if (diff.removed > 0 || diff.moved > 0) {
    return 'modal';
  }

  // Folder set differs (folders only in browser) → user must decide
  if (diff.snapshotDiffInfo?.hasFolderSetDiff) {
    return 'modal';
  }

  // Everything else is auto-resolvable: new items, properties, order, new folders
  return 'auto';
}
