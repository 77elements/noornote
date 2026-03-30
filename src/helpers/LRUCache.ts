/**
 * LRUCache - Generic LRU Cache with optional TTL
 *
 * Drop-in replacement for Map with:
 * - LRU eviction when cache exceeds maxSize
 * - Optional TTL (entries expire after maxAge ms)
 * - Platform-aware cache sizing via getCacheSize()
 *
 * Based on the proven pattern from NoteService/UserProfileService.
 */

import { PlatformService } from '../services/PlatformService';

/**
 * Returns platform-appropriate cache size.
 * Tauri Desktop (most RAM) > Web (shared browser RAM) > Mobile APK (least RAM)
 */
export function getCacheSize(tauriDesktop: number, web: number, mobile: number): number {
  const platform = PlatformService.getInstance();
  if (platform.isAndroid) return mobile;
  if (platform.isBrowser) return web;
  return tauriDesktop;
}

export class LRUCache<V> {
  private map: Map<string, { value: V; insertedAt: number }> = new Map();
  private readonly maxSize: number;
  private readonly maxAge: number | null;

  /**
   * @param maxSize Maximum number of entries before LRU eviction
   * @param maxAge Optional TTL in ms — entries older than this are treated as missing on get()
   */
  constructor(maxSize: number, maxAge?: number) {
    this.maxSize = maxSize;
    this.maxAge = maxAge ?? null;
  }

  /**
   * Get value by key. Returns undefined if missing or expired.
   * Touches the entry (moves to end = most recent).
   */
  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    // TTL check
    if (this.maxAge !== null && (Date.now() - entry.insertedAt) > this.maxAge) {
      this.map.delete(key);
      return undefined;
    }

    // LRU touch: move to end
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /**
   * Set value. Evicts oldest entries if cache is full.
   */
  set(key: string, value: V): void {
    // Re-insert to move to end (LRU)
    if (this.map.has(key)) {
      this.map.delete(key);
    }

    // Evict oldest entries if cache is full
    while (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      } else {
        break;
      }
    }

    this.map.set(key, { value, insertedAt: Date.now() });
  }

  /**
   * Check if key exists (without touching / without TTL check).
   */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /**
   * Delete a single entry.
   */
  delete(key: string): boolean {
    return this.map.delete(key);
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.map.clear();
  }

  /**
   * Number of entries currently in the cache.
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * Iterate over entries (like Map.forEach). Does NOT touch entries.
   */
  forEach(callback: (value: V, key: string) => void): void {
    for (const [key, entry] of this.map) {
      callback(entry.value, key);
    }
  }

  /**
   * Iterate over entries (like Map.entries). Does NOT touch entries.
   */
  *entries(): IterableIterator<[string, V]> {
    for (const [key, entry] of this.map) {
      yield [key, entry.value];
    }
  }

  /**
   * Iterate over keys.
   */
  keys(): IterableIterator<string> {
    return this.map.keys();
  }

  /**
   * Iterate over values. Does NOT touch entries.
   */
  *values(): IterableIterator<V> {
    for (const entry of this.map.values()) {
      yield entry.value;
    }
  }
}
