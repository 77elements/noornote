/**
 * @abstract BaseListStorageAdapter
 * @purpose Base class for list storage adapters with common browser storage logic
 * @used-by MuteStorageAdapter, FollowStorageAdapter, BookmarkStorageAdapter
 *
 * Provides:
 * - Common browser storage (PerAccountLocalStorage) read/write with deduplication
 * - Template methods for file and relay operations
 */

import type { ListStorageAdapter, FetchFromRelaysResult } from '../ListStorageAdapter';
import { PerAccountLocalStorage, type StorageKey } from '../../PerAccountLocalStorage';

export abstract class BaseListStorageAdapter<T> implements ListStorageAdapter<T> {
  protected perAccountStorage = PerAccountLocalStorage.getInstance();

  /**
   * Get the localStorage key for this list type (legacy, for migration)
   */
  protected abstract getBrowserStorageKey(): string;

  /**
   * Get the per-account storage key for this list type
   * Override in subclass to enable per-account storage
   */
  protected getPerAccountStorageKey(): StorageKey | null {
    return null;
  }

  /**
   * Get the log prefix for error messages
   */
  protected abstract getLogPrefix(): string;

  /**
   * Get unique ID for an item (used for deduplication)
   */
  abstract getItemId(item: T): string;

  /**
   * Read items from file storage (implementation-specific)
   */
  abstract getFileItems(): Promise<T[]>;

  /**
   * Write items to file storage (implementation-specific)
   */
  abstract setFileItems(items: T[]): Promise<void>;

  /**
   * Fetch items from relays (implementation-specific)
   * Returns FetchFromRelaysResult with items AND relayContentWasEmpty flag
   * (used to handle mixed-client private item edge case - see LIST-MANAGEMENT-SPEC.md)
   */
  abstract fetchFromRelays(): Promise<FetchFromRelaysResult<T>>;

  /**
   * Publish items to relays (implementation-specific)
   */
  abstract publishToRelays(items: T[]): Promise<void>;

  /**
   * Browser Storage (Runtime) - Synchronous Read
   * Uses per-account storage if available, falls back to legacy global storage
   */
  getBrowserItems(): T[] {
    try {
      const perAccountKey = this.getPerAccountStorageKey();
      if (perAccountKey) {
        return this.perAccountStorage.get<T[]>(perAccountKey, []);
      }

      // Fallback: Legacy global storage
      const stored = localStorage.getItem(this.getBrowserStorageKey());
      if (!stored) return [];
      return JSON.parse(stored);
    } catch (error) {
      console.error(`[${this.getLogPrefix()}] Failed to read from browser storage:`, error);
      return [];
    }
  }

  /**
   * Browser Storage (Runtime) - Synchronous Write
   * Uses per-account storage if available, falls back to legacy global storage
   */
  setBrowserItems(items: T[]): void {
    try {
      const uniqueItems = this.deduplicateItems(items);
      const perAccountKey = this.getPerAccountStorageKey();

      if (perAccountKey) {
        this.perAccountStorage.set(perAccountKey, uniqueItems);
        return;
      }

      // Fallback: Legacy global storage
      localStorage.setItem(this.getBrowserStorageKey(), JSON.stringify(uniqueItems));
    } catch (error) {
      console.error(`[${this.getLogPrefix()}] Failed to write to browser storage:`, error);
      throw error;
    }
  }

  /**
   * Deduplicate items by their unique ID
   * Common logic using getItemId() abstraction
   */
  protected deduplicateItems(items: T[]): T[] {
    const map = new Map<string, T>();
    items.forEach(item => map.set(this.getItemId(item), item));
    return Array.from(map.values());
  }

  /**
   * Helper: Get current timestamp for file metadata
   */
  protected getCurrentTimestamp(): number {
    return Math.floor(Date.now() / 1000);
  }
}
