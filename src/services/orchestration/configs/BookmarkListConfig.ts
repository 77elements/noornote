/**
 * BookmarkListConfig - Configuration for bookmark list management
 * Used by BookmarkOrchestrator via GenericListOrchestrator
 */

import type { ListConfig, FileStorageWrapper } from '../../../types/ListConfig';
import type { BookmarkItem } from '../../storage/BookmarkFileStorage';
import { BookmarkFileStorage } from '../../storage/BookmarkFileStorage';
import { StorageKeys } from '../../PerAccountLocalStorage';

/**
 * File Storage Wrapper for Bookmarks
 */
class BookmarkFileStorageWrapper implements FileStorageWrapper<BookmarkItem> {
  private storage: BookmarkFileStorage;

  constructor() {
    this.storage = BookmarkFileStorage.getInstance();
  }

  async readPublic(): Promise<{ items: BookmarkItem[]; lastModified: number }> {
    return await this.storage.readPublic();
  }

  async writePublic(data: { items: BookmarkItem[]; lastModified: number }): Promise<void> {
    await this.storage.writePublic(data);
  }

  async readPrivate(): Promise<{ items: BookmarkItem[]; lastModified: number }> {
    return await this.storage.readPrivate();
  }

  async writePrivate(data: { items: BookmarkItem[]; lastModified: number }): Promise<void> {
    await this.storage.writePrivate(data);
  }

  async getAllItems(): Promise<BookmarkItem[]> {
    return await this.storage.getAllBookmarks();
  }
}

/**
 * Bookmark List Configuration
 */
export const bookmarkListConfig: ListConfig<BookmarkItem> = {
  // Identification
  name: 'bookmarks',
  browserStorageKey: 'noornote_bookmarks_browser',  // Legacy (for migration)
  perAccountStorageKey: StorageKeys.BOOKMARKS,      // Per-account storage

  // Nostr Event (NIP-51: Bookmark Sets - one event per category)
  publicEventKind: 30003,       // kind:30003 (bookmark sets)

  // Encryption
  encryptPrivateContent: true,  // Private bookmarks are encrypted in content

  // Item Operations
  getItemId: (item: BookmarkItem) => item.id,

  itemToTags: (item: BookmarkItem) => {
    return [[item.type, item.value]];
  },

  tagsToItem: (tags: string[][], timestamp: number): BookmarkItem[] => {
    // Extract all bookmark tags (e, a, t, r)
    const items: BookmarkItem[] = [];

    tags.forEach(tag => {
      if (tag[0] === 'e' && tag[1]) {
        items.push({
          id: tag[1],
          type: 'e',
          value: tag[1],
          addedAt: timestamp
        });
      } else if (tag[0] === 'a' && tag[1]) {
        items.push({
          id: tag[1],
          type: 'a',
          value: tag[1],
          addedAt: timestamp
        });
      } else if (tag[0] === 't' && tag[1]) {
        items.push({
          id: tag[1],
          type: 't',
          value: tag[1],
          addedAt: timestamp
        });
      } else if (tag[0] === 'r' && tag[1]) {
        items.push({
          id: tag[1],
          type: 'r',
          value: tag[1],
          addedAt: timestamp
        });
      }
    });

    return items;
  }
  // Note: No custom decryptPrivateItems - uses GenericListOrchestrator default
  // which properly decrypts NIP-44/NIP-04 content, parses JSON tags, and converts via tagsToItem
};

/**
 * Create File Storage Wrapper instance
 */
export function createBookmarkFileStorageWrapper(): FileStorageWrapper<BookmarkItem> {
  return new BookmarkFileStorageWrapper();
}
