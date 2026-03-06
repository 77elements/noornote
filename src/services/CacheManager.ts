/**
 * Cache Manager Service
 * Centralized cache management for localStorage, sessionStorage, and NDK cache
 */

import { getStorageSize } from '../helpers/getStorageSize';

export interface CacheStats {
  localStorage: {
    size: number;
    items: number;
  };
  sessionStorage: {
    size: number;
    items: number;
  };
  ndkCache: {
    size: number;
    items: number;
  };
  total: {
    size: number;
    items: number;
  };
}

export interface ClearCacheOptions {
  localStorage?: boolean;
  sessionStorage?: boolean;
  profileCache?: boolean;
  eventCache?: boolean;
  notificationsCache?: boolean;
  reload?: boolean;
}

export class CacheManager {
  private static instance: CacheManager;

  private constructor() {
    // Private constructor for singleton
  }

  public static getInstance(): CacheManager {
    if (!CacheManager.instance) {
      CacheManager.instance = new CacheManager();
    }
    return CacheManager.instance;
  }

  /**
   * Get detailed cache statistics (async to include NDK cache)
   */
  public async getCacheStats(): Promise<CacheStats> {
    const localStorageSize = getStorageSize(localStorage);
    const sessionStorageSize = getStorageSize(sessionStorage);
    const { size: ndkCacheSize, count: ndkCacheCount } = await this.getNDKCacheSize();

    return {
      localStorage: {
        size: localStorageSize,
        items: localStorage.length
      },
      sessionStorage: {
        size: sessionStorageSize,
        items: sessionStorage.length
      },
      ndkCache: {
        size: ndkCacheSize,
        items: ndkCacheCount
      },
      total: {
        size: localStorageSize + sessionStorageSize + ndkCacheSize,
        items: localStorage.length + sessionStorage.length + ndkCacheCount
      }
    };
  }

  /**
   * Get NDK cache size (measures safe tables only)
   */
  private async getNDKCacheSize(): Promise<{ size: number; count: number }> {
    try {
      // Get db from NDK cache (initialized by NostrTransport)
      const { db } = await import('@nostr-dev-kit/ndk-cache-dexie');

      // Check if db is initialized (has tables)
      if (!db || !db.tables || db.tables.length === 0) {
        // DB not initialized yet
        return { size: 0, count: 0 };
      }

      // Only measure safe tables (exclude unpublishedEvents, decryptedEvents, eventRelays)
      // Note: eventRelays removed - table may not exist in all DB versions
      const safeTableNames = ['events', 'profiles', 'eventTags', 'nip05', 'lnurl', 'relayStatus'];

      // Check which tables actually exist
      const existingTables = safeTableNames.filter(tableName =>
        db.tables.some((t: any) => t.name === tableName)
      );

      if (existingTables.length === 0) {
        return { size: 0, count: 0 };
      }

      // Count items in existing tables
      const counts = await Promise.all(
        existingTables.map(tableName => (db as any)[tableName].count())
      );

      const totalCount = counts.reduce((sum, count) => sum + count, 0);

      // Estimate size by sampling (max 100 items per table)
      const SAMPLE_SIZE = 100;
      let totalSize = 0;

      for (let i = 0; i < existingTables.length; i++) {
        const tableName = existingTables[i]!;
        const tableCount = counts[i]!;
        if (tableCount === 0) continue;

        const sample = await (db as any)[tableName].limit(SAMPLE_SIZE).toArray();
        let sampleBytes = 0;
        sample.forEach((item: any) => {
          sampleBytes += JSON.stringify(item).length;
        });

        const avgItemSize = sampleBytes / sample.length;
        totalSize += Math.round(avgItemSize * tableCount);
      }

      return { size: totalSize, count: totalCount };
    } catch (error) {
      console.error('Failed to get NDK cache size:', error);
      return { size: 0, count: 0 };
    }
  }

  /**
   * Clear caches based on options - equivalent to DevTools "Clear Site Data"
   */
  public async clearCache(options: ClearCacheOptions = {}): Promise<void> {
    const {
      localStorage: clearLocalStorage = true,
      sessionStorage: clearSessionStorage = true,
      profileCache = true,
      eventCache = true,
      notificationsCache = true,
      reload = true
    } = options;

    console.log('🧹 CacheManager: Starting complete site data clear (like DevTools)');

    try {
      // Clear localStorage
      if (clearLocalStorage) {
        localStorage.clear();
        console.log('✅ localStorage cleared');
      }

      // Clear sessionStorage
      if (clearSessionStorage) {
        sessionStorage.clear();
        console.log('✅ sessionStorage cleared');
      }

      // Clear Cache Storage (Service Workers)
      await this.clearCacheStorage();

      // Clear specific profile cache if UserProfileService is available
      if (profileCache) {
        this.clearProfileCache();
      }

      // Clear event cache
      if (eventCache) {
        this.clearEventCache();
      }

      // Clear notifications cache
      if (notificationsCache) {
        this.clearNotificationsCache();
      }

      console.log('✅ Complete site data clear completed successfully (equivalent to DevTools)');

      // Reload page if requested
      if (reload) {
        setTimeout(() => {
          window.location.reload();
        }, 500);
      }

    } catch (error) {
      console.error('❌ Error during site data clear operation:', error);
      throw error;
    }
  }

  /**
   * Clear profile cache through UserProfileService
   */
  private clearProfileCache(): void {
    try {
      // Try to access UserProfileService if available
      const userProfileService = (window as any).userProfileService;
      if (userProfileService && typeof userProfileService.clearCache === 'function') {
        userProfileService.clearCache();
        console.log('✅ Profile cache cleared');
      } else {
        console.log('ℹ️ UserProfileService not available for cache clearing');
      }
    } catch (error) {
      console.warn('⚠️ Failed to clear profile cache:', error);
    }
  }

  /**
   * Clear user-specific caches when switching accounts
   * These caches contain data specific to a user and should not persist across account switches
   */
  public clearUserSpecificCaches(): void {
    const keysToRemove = [
      'noornote_follows_browser',
      'noornote_bookmarks_browser',
      'noornote_mutes_browser_v2',
      'noornote_notifications_cache',
      'noornote_notifications_last_seen',
      'noornote_user_event_ids',
      'noornote_user_event_ancestry',
      'noornote_bookmark_folders',
      'noornote_bookmark_folder_assignments',
      'noornote_bookmark_root_order'
    ];

    keysToRemove.forEach(key => localStorage.removeItem(key));
  }

  /**
   * Clear event cache (legacy placeholder)
   */
  private clearEventCache(): void {
    // Event cache clearing is now handled by individual services
    console.log('ℹ️ Event cache clearing delegated to individual services');
  }

  /**
   * Clear notifications cache through NotificationsCacheService
   */
  private clearNotificationsCache(): void {
    try {
      // Dynamically import to avoid circular dependencies
      import('./NotificationsCacheService').then(module => {
        const cacheService = module.NotificationsCacheService.getInstance();
        cacheService.clearCache();
        console.log('✅ Notifications cache cleared');
      }).catch(error => {
        console.warn('⚠️ Failed to clear notifications cache:', error);
      });
    } catch (error) {
      console.warn('⚠️ Failed to clear notifications cache:', error);
    }
  }

  /**
   * Clear Cache Storage (Service Workers)
   */
  private async clearCacheStorage(): Promise<void> {
    try {
      if (!('caches' in window)) {
        console.log('ℹ️ Cache Storage not supported');
        return;
      }

      // Get all cache names
      const cacheNames = await caches.keys();

      if (cacheNames.length === 0) {
        console.log('ℹ️ No Cache Storage to clear');
        return;
      }

      // Delete each cache
      const deletePromises = cacheNames.map(async (cacheName) => {
        try {
          await caches.delete(cacheName);
          console.log(`✅ Cache Storage '${cacheName}' deleted`);
        } catch (error) {
          console.warn(`⚠️ Failed to delete cache '${cacheName}':`, error);
        }
      });

      await Promise.all(deletePromises);
      console.log('✅ All Cache Storage cleared');

    } catch (error) {
      console.warn('⚠️ Failed to clear Cache Storage:', error);
    }
  }

  /**
   * Get approximate size of storage in bytes
   */

  /**
   * Format bytes to human readable string (whole numbers only, no decimals)
   */
  public formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return Math.round(bytes / Math.pow(k, i)) + ' ' + sizes[i];
  }

  /**
   * Check if cache size exceeds threshold
   */
  public async isCacheOversized(thresholdMB: number = 50): Promise<boolean> {
    const stats = await this.getCacheStats();
    const thresholdBytes = thresholdMB * 1024 * 1024;
    return stats.total.size > thresholdBytes;
  }
}