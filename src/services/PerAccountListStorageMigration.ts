/**
 * PerAccountListStorageMigration
 * Migrates legacy global localStorage data to per-account storage
 *
 * Legacy keys (global):
 * - noornote_bookmarks_browser
 * - noornote_bookmark_folders
 * - noornote_bookmark_folder_assignments
 * - noornote_bookmark_root_order
 * - noornote_follows_browser
 * - noornote_mutes_browser_v2
 *
 * New keys (per-account map format):
 * - noornote_bookmarks_map
 * - noornote_bookmark_folders_map
 * - noornote_bookmark_folder_assignments_map
 * - noornote_bookmark_root_order_map
 * - noornote_follows_map
 * - noornote_mutes_map
 */

import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { SystemLogger } from '../components/system/SystemLogger';
import { BookmarkFolderService } from './BookmarkFolderService';

// Legacy keys
const LEGACY_KEYS = {
  BOOKMARKS: 'noornote_bookmarks_browser',
  BOOKMARK_FOLDERS: 'noornote_bookmark_folders',
  BOOKMARK_FOLDER_ASSIGNMENTS: 'noornote_bookmark_folder_assignments',
  BOOKMARK_ROOT_ORDER: 'noornote_bookmark_root_order',
  FOLLOWS: 'noornote_follows_browser',
  MUTES: 'noornote_mutes_browser_v2',
};

export class PerAccountListStorageMigration {
  private static instance: PerAccountListStorageMigration;
  private storage: PerAccountLocalStorage;
  private logger: SystemLogger;

  private constructor() {
    this.storage = PerAccountLocalStorage.getInstance();
    this.logger = SystemLogger.getInstance();
  }

  public static getInstance(): PerAccountListStorageMigration {
    if (!PerAccountListStorageMigration.instance) {
      PerAccountListStorageMigration.instance = new PerAccountListStorageMigration();
    }
    return PerAccountListStorageMigration.instance;
  }

  /**
   * Migrate legacy data for a specific user
   * Called after login when we know the user's pubkey
   */
  public migrateForUser(pubkey: string): void {
    this.logger.info('PerAccountListStorageMigration', `Checking migration for ${pubkey.slice(0, 8)}...`);

    let migrated = false;

    // Migrate bookmarks
    if (this.migrateLegacyData(LEGACY_KEYS.BOOKMARKS, StorageKeys.BOOKMARKS, pubkey)) {
      migrated = true;
    }

    // Migrate bookmark folders
    if (this.migrateLegacyData(LEGACY_KEYS.BOOKMARK_FOLDERS, StorageKeys.BOOKMARK_FOLDERS, pubkey)) {
      migrated = true;
    }

    // Migrate bookmark folder assignments
    if (this.migrateLegacyData(LEGACY_KEYS.BOOKMARK_FOLDER_ASSIGNMENTS, StorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS, pubkey)) {
      migrated = true;
    }

    // Migrate bookmark root order
    if (this.migrateLegacyData(LEGACY_KEYS.BOOKMARK_ROOT_ORDER, StorageKeys.BOOKMARK_ROOT_ORDER, pubkey)) {
      migrated = true;
    }

    // Migrate follows
    if (this.migrateLegacyData(LEGACY_KEYS.FOLLOWS, StorageKeys.FOLLOWS, pubkey)) {
      migrated = true;
    }

    // Migrate mutes
    if (this.migrateLegacyData(LEGACY_KEYS.MUTES, StorageKeys.MUTES, pubkey)) {
      migrated = true;
    }

    if (migrated) {
      this.logger.info('PerAccountListStorageMigration', `Migration completed for ${pubkey.slice(0, 8)}`);
    }

    // Clean up orphaned folder assignments (assignments referencing non-existent bookmarks)
    const folderService = BookmarkFolderService.getInstance();
    const removedOrphans = folderService.cleanupOrphanedAssignments();
    if (removedOrphans > 0) {
      this.logger.info('PerAccountListStorageMigration',
        `Cleaned up ${removedOrphans} orphaned folder assignments`
      );
    }
  }

  /**
   * Migrate a single legacy key to per-account storage
   * Returns true if migration happened
   */
  private migrateLegacyData(
    legacyKey: string,
    newKey: typeof StorageKeys[keyof typeof StorageKeys],
    pubkey: string
  ): boolean {
    try {
      // Check if legacy data exists
      const legacyData = localStorage.getItem(legacyKey);
      if (!legacyData) {
        return false;
      }

      // Check if new per-account data already exists for this user
      const existingData = this.storage.getForPubkey(newKey, pubkey, null);
      if (existingData !== null) {
        // User already has per-account data, skip migration
        // But still clean up legacy data
        this.cleanupLegacyKey(legacyKey);
        return false;
      }

      // Parse legacy data
      const parsed = JSON.parse(legacyData);

      // Migrate to per-account storage
      this.storage.setForPubkey(newKey, pubkey, parsed);

      this.logger.info('PerAccountListStorageMigration',
        `Migrated ${legacyKey} to per-account storage for ${pubkey.slice(0, 8)}`
      );

      // Clean up legacy key
      this.cleanupLegacyKey(legacyKey);

      return true;
    } catch (error) {
      this.logger.error('PerAccountListStorageMigration',
        `Failed to migrate ${legacyKey}: ${error}`
      );
      return false;
    }
  }

  /**
   * Clean up legacy key after migration
   * We remove it to prevent confusion and data leakage
   */
  private cleanupLegacyKey(legacyKey: string): void {
    try {
      localStorage.removeItem(legacyKey);
      this.logger.info('PerAccountListStorageMigration',
        `Removed legacy key: ${legacyKey}`
      );
    } catch (error) {
      this.logger.error('PerAccountListStorageMigration',
        `Failed to remove legacy key ${legacyKey}: ${error}`
      );
    }
  }

  /**
   * Check if any legacy data exists (for debugging)
   */
  public hasLegacyData(): boolean {
    return Object.values(LEGACY_KEYS).some(key => localStorage.getItem(key) !== null);
  }
}
