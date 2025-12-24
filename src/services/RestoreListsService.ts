/**
 * RestoreListsService
 * Cascading restore logic for ALL lists (Follows, Bookmarks, Mutes, Tribes)
 *
 * Sync Mode Behavior:
 * - Manual Mode: Only read browser storage, no auto-restore
 * - Easy Mode:   Cascading restore (browser → file → relays)
 *
 * Priority (Easy Mode):
 * 1. Browser storage (localStorage) - fastest, session state
 * 2. Local file (~/.noornote/*.json) - offline, has folder structure
 * 3. Relays - network, NIP-51 events
 *
 * @purpose Restore empty lists from local file or relays based on sync mode
 * @used-by BookmarkManager, MuteListManager, FollowListManager, TribeManager
 */

import { ListSyncManager, type SyncFromRelaysResult } from './sync/ListSyncManager';
import { getListSyncMode } from '../helpers/ListSyncButtonsHelper';
import { SystemLogger } from '../components/system/SystemLogger';

export interface RestoreResult {
  source: 'browser' | 'file' | 'relays' | 'empty';
  itemCount: number;
}

export class RestoreListsService {
  private static instance: RestoreListsService;
  private systemLogger: SystemLogger;

  private constructor() {
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): RestoreListsService {
    if (!RestoreListsService.instance) {
      RestoreListsService.instance = new RestoreListsService();
    }
    return RestoreListsService.instance;
  }

  /**
   * Restore a list using cascading logic (respects sync mode)
   *
   * @param listSyncManager - The list's sync manager
   * @param getBrowserItems - Function to get current browser items
   * @param setBrowserItems - Function to set browser items
   * @param listName - Name for logging (e.g., 'Bookmarks', 'Mutes', 'Follows', 'Tribes')
   * @param afterRelaySync - Optional callback after relay sync (e.g., create folders from categories)
   * @returns RestoreResult with source and item count
   */
  public async restoreIfEmpty<T>(
    listSyncManager: ListSyncManager<T>,
    getBrowserItems: () => T[],
    _setBrowserItems: (items: T[]) => void,
    listName: string,
    afterRelaySync?: (result: SyncFromRelaysResult<T>) => Promise<void>
  ): Promise<RestoreResult> {
    const syncMode = getListSyncMode();

    // Manual Mode: Only read browser storage, no auto-restore
    if (syncMode === 'manual') {
      const items = getBrowserItems();
      if (items.length > 0) {
        this.systemLogger.info('RestoreListsService', `${listName}: Manual Mode - using browser storage (${items.length} items)`);
        return { source: 'browser', itemCount: items.length };
      } else {
        this.systemLogger.info('RestoreListsService', `${listName}: Manual Mode - browser storage empty, no auto-restore`);
        return { source: 'empty', itemCount: 0 };
      }
    }

    // Easy Mode: Cascading restore (browser → file → relays)
    this.systemLogger.info('RestoreListsService', `${listName}: Easy Mode - starting cascading restore...`);

    // Step 1: Check browser storage
    let items = getBrowserItems();
    if (items.length > 0) {
      return { source: 'browser', itemCount: items.length };
    }

    this.systemLogger.info('RestoreListsService', `${listName}: Browser storage empty, trying local file...`);

    // Step 2: Try local file
    try {
      // Restore folder data before file restore (for Bookmarks/Tribes with folders)
      const adapter = (listSyncManager as any).adapter;
      if (adapter && typeof adapter.restoreFolderDataFromFile === 'function') {
        await adapter.restoreFolderDataFromFile();
      }

      const restored = await listSyncManager.restoreFromFile();
      if (restored) {
        items = getBrowserItems();
        if (items.length > 0) {
          this.systemLogger.info('RestoreListsService', `${listName}: Restored ${items.length} items from local file`);
          return { source: 'file', itemCount: items.length };
        }
      }
    } catch (_error) {
      this.systemLogger.warn('RestoreListsService', `${listName}: Failed to restore from local file`, _error);
    }

    this.systemLogger.info('RestoreListsService', `${listName}: Local file empty, trying relays...`);

    // Step 3: Try relays
    try {
      const result = await listSyncManager.syncFromRelays();
      if (result.relayItems.length > 0) {
        // Apply relay items to browser storage
        await listSyncManager.applySyncFromRelays('merge', result.relayItems, result.relayContentWasEmpty);

        // Call afterRelaySync callback (e.g., create folders from categories)
        if (afterRelaySync) {
          await afterRelaySync(result);
        }

        items = getBrowserItems();
        if (items.length > 0) {
          this.systemLogger.info('RestoreListsService', `${listName}: Restored ${items.length} items from relays`);
          return { source: 'relays', itemCount: items.length };
        }
      }
    } catch (_error) {
      this.systemLogger.warn('RestoreListsService', `${listName}: Failed to fetch from relays`, _error);
    }

    // Step 4: List is truly empty
    this.systemLogger.info('RestoreListsService', `${listName}: List is empty (no data in browser, file, or relays)`);
    return { source: 'empty', itemCount: 0 };
  }
}
