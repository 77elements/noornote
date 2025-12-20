/**
 * @adapter BookmarkStorageAdapter
 * @purpose Storage adapter for bookmark lists (public + private merged)
 * @used-by ListSyncManager
 *
 * Storage Locations:
 * - Browser: localStorage key 'noornote_bookmarks_browser' (BookmarkItem[])
 * - File: ~/.noornote/{npub}/bookmarks.json
 * - Relays: kind:30003 (Bookmark Sets) events
 */

import { BaseListStorageAdapter } from './BaseListStorageAdapter';
import { BookmarkFileStorage, type BookmarkItem } from '../../storage/BookmarkFileStorage';
import type { FetchFromRelaysResult } from '../ListStorageAdapter';
import { BookmarkOrchestrator } from '../../orchestration/BookmarkOrchestrator';
import { AuthService } from '../../AuthService';
import { SystemLogger } from '../../../components/system/SystemLogger';
import { StorageKeys, type StorageKey } from '../../PerAccountLocalStorage';

export class BookmarkStorageAdapter extends BaseListStorageAdapter<BookmarkItem> {
  private fileStorage: BookmarkFileStorage;
  private bookmarkOrchestrator: BookmarkOrchestrator;
  private authService: AuthService;
  private logger = SystemLogger.getInstance();

  constructor() {
    super();
    this.fileStorage = BookmarkFileStorage.getInstance();
    this.bookmarkOrchestrator = BookmarkOrchestrator.getInstance();
    this.authService = AuthService.getInstance();
  }

  protected getBrowserStorageKey(): string {
    return 'noornote_bookmarks_browser';  // Legacy, for migration only
  }

  protected override getPerAccountStorageKey(): StorageKey {
    return StorageKeys.BOOKMARKS;
  }

  protected getLogPrefix(): string {
    return 'BookmarkStorageAdapter';
  }

  /**
   * Get unique ID for bookmark item (id field)
   */
  getItemId(item: BookmarkItem): string {
    return item.id;
  }

  /**
   * File Storage (Persistent Local) - Asynchronous
   * Reads all bookmarks from file with category info
   */
  async getFileItems(): Promise<BookmarkItem[]> {
    try {
      // Use getAllBookmarks() which properly reads the new BookmarkSetData format
      // and extracts items with their category field
      return await this.fileStorage.getAllBookmarks();
    } catch (error) {
      this.logger.error('BookmarkStorageAdapter', `Failed to read from file storage: ${error}`);
      throw error;
    }
  }

  /**
   * File Storage (Persistent Local) - Asynchronous
   * Writes items to files using BookmarkSetData format with categories
   */
  async setFileItems(_items: BookmarkItem[]): Promise<void> {
    try {
      // Use orchestrator to save in BookmarkSetData format (with categories)
      await this.bookmarkOrchestrator.saveToFile();
    } catch (error) {
      this.logger.error('BookmarkStorageAdapter', `Failed to write to file storage: ${error}`);
      throw error;
    }
  }

  /**
   * Restore folder data from file to per-account storage
   * Uses getAllFolderData() to include BOTH public AND private bookmark assignments
   */
  async restoreFolderDataFromFile(): Promise<void> {
    try {
      // Use new method that includes both public and private bookmarks
      const folderData = await this.fileStorage.getAllFolderData();

      if (folderData.folders.length > 0) {
        this.perAccountStorage.set(StorageKeys.BOOKMARK_FOLDERS, folderData.folders);
      }
      if (folderData.folderAssignments.length > 0) {
        this.perAccountStorage.set(StorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS, folderData.folderAssignments);
      }
      if (folderData.rootOrder.length > 0) {
        this.perAccountStorage.set(StorageKeys.BOOKMARK_ROOT_ORDER, folderData.rootOrder);
      }
    } catch (error) {
      this.logger.error('BookmarkStorageAdapter', `Failed to restore folder data: ${error}`);
    }
  }

  /**
   * Relay Storage (Remote) - Asynchronous
   * Fetches kind:10003 event, returns merged bookmarks with metadata
   * Returns FetchFromRelaysResult to support mixed-client private item handling
   */
  async fetchFromRelays(): Promise<FetchFromRelaysResult<BookmarkItem>> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        throw new Error('User not authenticated');
      }

      return await this.bookmarkOrchestrator.fetchBookmarksFromRelays(currentUser.pubkey);
    } catch (error) {
      this.logger.error('BookmarkStorageAdapter', `Failed to fetch from relays: ${error}`);
      throw error;
    }
  }

  /**
   * Relay Storage (Remote) - Asynchronous
   * Publishes kind:10003 + kind:30003 events respecting isPrivate flag
   *
   * Strategy: Same as setFileItems - uses isPrivate flag from browser items,
   * falls back to existing file location for items without explicit flag.
   */
  async publishToRelays(items: BookmarkItem[]): Promise<void> {
    try {
      // First, save to files using the same logic as setFileItems
      await this.setFileItems(items);

      // Then publish via orchestrator (reads from files)
      await this.bookmarkOrchestrator.publishToRelays();
    } catch (error) {
      this.logger.error('BookmarkStorageAdapter', `Failed to publish to relays: ${error}`);
      throw error;
    }
  }
}
