/**
 * Notifications Cache Service
 * Manages per-user localStorage cache for notifications (fast reload on view switches)
 *
 * Features:
 * - Cache notifications per-user in localStorage (Jumble Pattern)
 * - Track lastSeen (for badge calculation)
 * - Track lastFetch (for incremental updates)
 * - FIFO queue (max X notifications, configurable)
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';

interface NotificationsCache {
  events: NostrEvent[];
  lastSeen: number;      // Unix timestamp (last time user opened NV)
  lastFetch: number;     // Unix timestamp (last fetch time)
}

export class NotificationsCacheService {
  private static instance: NotificationsCacheService;
  private limitKey = 'noornote_notifications_cache_limit'; // Global setting, not per-user
  private defaultLimit = 100;
  private perAccountStorage: PerAccountLocalStorage;
  // Bump this version to force cache clear (e.g., after fixing hashtag notification caching bug)
  private static readonly CACHE_VERSION = 2;
  private static readonly CACHE_VERSION_KEY = 'noornote_notifications_cache_version';

  private constructor() {
    this.perAccountStorage = PerAccountLocalStorage.getInstance();
    this.runMigrations();
  }

  /**
   * Run one-time migrations (e.g., clear cache after bug fixes)
   */
  private runMigrations(): void {
    const storedVersion = parseInt(localStorage.getItem(NotificationsCacheService.CACHE_VERSION_KEY) || '0', 10);

    if (storedVersion < NotificationsCacheService.CACHE_VERSION) {
      // Clear notifications cache to fix hashtag notifications being re-classified as mentions
      this.perAccountStorage.remove(StorageKeys.NOTIFICATIONS_CACHE);
      localStorage.setItem(NotificationsCacheService.CACHE_VERSION_KEY, NotificationsCacheService.CACHE_VERSION.toString());
    }
  }

  public static getInstance(): NotificationsCacheService {
    if (!NotificationsCacheService.instance) {
      NotificationsCacheService.instance = new NotificationsCacheService();
    }
    return NotificationsCacheService.instance;
  }

  /**
   * Get cache limit (user-configurable in Settings) - global, not per-user
   */
  public getLimit(): number {
    try {
      const stored = localStorage.getItem(this.limitKey);
      if (stored) {
        const limit = parseInt(stored, 10);
        return limit > 0 ? limit : this.defaultLimit;
      }
    } catch (error) {
      console.error('Failed to load cache limit:', error);
    }
    return this.defaultLimit;
  }

  /**
   * Set cache limit
   */
  public setLimit(limit: number): void {
    try {
      localStorage.setItem(this.limitKey, limit.toString());
    } catch (error) {
      console.error('Failed to save cache limit:', error);
    }
  }

  /**
   * Load cache from per-account storage
   */
  public loadCache(): NotificationsCache | null {
    return this.perAccountStorage.get<NotificationsCache | null>(StorageKeys.NOTIFICATIONS_CACHE, null);
  }

  /**
   * Save cache to per-account storage
   */
  public saveCache(cache: NotificationsCache): void {
    this.perAccountStorage.set(StorageKeys.NOTIFICATIONS_CACHE, cache);
  }

  /**
   * Update lastSeen timestamp (called when user opens NV)
   */
  public updateLastSeen(): void {
    const now = Math.floor(Date.now() / 1000);
    const cache = this.loadCache();
    if (cache) {
      cache.lastSeen = now;
      this.saveCache(cache);
    } else {
      // Initialize cache if not exists
      this.saveCache({
        events: [],
        lastSeen: now,
        lastFetch: 0
      });
    }

    // Also update NotificationsOrchestrator's lastSeen (for badge count)
    // Uses the same per-account storage key
    this.perAccountStorage.set(StorageKeys.NOTIFICATIONS_LAST_SEEN, now);
  }

  /**
   * Get lastSeen timestamp
   */
  public getLastSeen(): number {
    const cache = this.loadCache();
    return cache?.lastSeen || 0;
  }

  /**
   * Get lastFetch timestamp
   */
  public getLastFetch(): number {
    const cache = this.loadCache();
    return cache?.lastFetch || 0;
  }

  /**
   * Add new notifications to cache (FIFO queue)
   * Merges with existing, sorts by created_at DESC, keeps only newest X
   */
  public addNotifications(newEvents: NostrEvent[]): void {
    const cache = this.loadCache() || {
      events: [],
      lastSeen: Math.floor(Date.now() / 1000),
      lastFetch: 0
    };

    // Merge new events with existing (deduplicate by id)
    const eventMap = new Map<string, NostrEvent>();

    // Add existing events (guard: skip events without id)
    cache.events.forEach(event => {
      if (event.id) eventMap.set(event.id, event);
    });

    // Add/overwrite with new events (guard: skip events without id)
    newEvents.forEach(event => {
      if (event.id) eventMap.set(event.id, event);
    });

    // Convert to array and sort by created_at DESC (newest first)
    const allEvents = Array.from(eventMap.values())
      .sort((a, b) => b.created_at - a.created_at);

    // Keep only newest X events (FIFO)
    const limit = this.getLimit();
    cache.events = allEvents.slice(0, limit);

    // Update lastFetch
    cache.lastFetch = Math.floor(Date.now() / 1000);

    this.saveCache(cache);
  }

  /**
   * Get cached notifications
   */
  public getCachedNotifications(): NostrEvent[] {
    const cache = this.loadCache();
    return cache?.events || [];
  }

  /**
   * Get count of new notifications since lastSeen (for badge)
   */
  public getNewCount(): number {
    const cache = this.loadCache();
    if (!cache) return 0;

    return cache.events.filter(event => event.created_at > cache.lastSeen).length;
  }

  /**
   * Clear cache for current user
   */
  public clearCache(): void {
    this.perAccountStorage.remove(StorageKeys.NOTIFICATIONS_CACHE);
  }

  /**
   * Initialize cache (called on first NV visit)
   */
  public initializeCache(): void {
    const existing = this.loadCache();
    if (!existing) {
      this.saveCache({
        events: [],
        lastSeen: Math.floor(Date.now() / 1000),
        lastFetch: 0
      });
    }
  }
}
