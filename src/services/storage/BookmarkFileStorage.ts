/**
 * BookmarkFileStorage
 * File-based storage for bookmark lists using Tauri FS API
 *
 * Stores bookmarks in a single file with the new sets-based format:
 * - ~/.noornote/{npub}/bookmarks.json
 *
 * Format (BookmarkSetData):
 * {
 *   "version": 2,
 *   "sets": [
 *     { "d": "", "title": "", "publicTags": [...], "privateTags": [...] },
 *     { "d": "Work", "title": "Work", "publicTags": [...], "privateTags": [...] }
 *   ],
 *   "metadata": { "setOrder": ["", "Work"], "lastModified": ... }
 * }
 * Note: d-tag = title-tag (always equal)
 */

import { BaseFileStorage, type BaseFileData } from './BaseFileStorage';
import type { BookmarkSetData } from '../../types/BookmarkSetData';
import {
  createEmptyBookmarkSetData,
  migrateFromOldFormat,
  isOldFormat,
  isNewFormat
} from '../sync/serializers/BookmarkSerializer';

/**
 * Bookmark item with NIP-51 type support
 * category = d-tag value ('' for root, 'Work' for category Work, etc.)
 */
export interface BookmarkItem {
  id: string;
  type: 'e' | 'a' | 't' | 'r';
  value: string;
  addedAt?: number;
  isPrivate?: boolean;
  category?: string;  // d-tag value, '' = root
  description?: string;  // optional user description for URL bookmarks
}

/**
 * Folder definition (legacy, for migration)
 */
export interface BookmarkFolder {
  id: string;
  name: string;
  createdAt: number;
  order: number;
}

/**
 * Bookmark-to-folder assignment (legacy, for migration)
 */
export interface FolderAssignment {
  bookmarkId: string;
  folderId: string;
  order: number;
}

/**
 * Root order item (legacy, for migration)
 */
export interface RootOrderItem {
  type: 'folder' | 'bookmark';
  id: string;
}

/**
 * Old file format (for migration detection)
 */
export interface BookmarkListData extends BaseFileData {
  items: BookmarkItem[];
  folders?: BookmarkFolder[];
  folderAssignments?: FolderAssignment[];
  rootOrder?: RootOrderItem[];
}

/**
 * Internal storage class for the new format
 */
class BookmarkSetStorage extends BaseFileStorage<BookmarkSetData> {
  protected getFileName(): string {
    return 'bookmarks.json';
  }

  protected getDefaultData(): BookmarkSetData {
    return createEmptyBookmarkSetData();
  }

  protected getLoggerName(): string {
    return 'BookmarkSetStorage';
  }

  /**
   * Override read to handle migration from old format
   */
  public override async read(): Promise<BookmarkSetData> {
    const rawData = await super.read();

    // Check if it's old format and needs migration
    if (isOldFormat(rawData)) {
      this.logger.info(this.getLoggerName(), 'Migrating from old format to BookmarkSetData');
      const migrated = migrateFromOldFormat(rawData as unknown as BookmarkListData);
      // Save migrated data
      await this.write(migrated);
      return migrated;
    }

    // Check if it's new format
    if (isNewFormat(rawData)) {
      return rawData;
    }

    // Unknown format, return empty
    this.logger.warn(this.getLoggerName(), 'Unknown format, returning empty data');
    return this.getDefaultData();
  }
}

/**
 * Legacy storage for reading old public file (migration only)
 * Read-only - never creates files
 */
class LegacyPublicBookmarkStorage extends BaseFileStorage<BookmarkListData> {
  protected getFileName(): string {
    return 'bookmarks-public.json';
  }

  protected getDefaultData(): BookmarkListData {
    return { items: [], lastModified: Math.floor(Date.now() / 1000) };
  }

  protected getLoggerName(): string {
    return 'LegacyPublicBookmarkStorage';
  }

  // Override to skip file creation - read-only for migration
  protected override async ensureFileExists(): Promise<void> {
    // Do nothing - never create legacy files
  }
}

/**
 * Legacy storage for reading old private file (migration only)
 * Read-only - never creates files
 */
class LegacyPrivateBookmarkStorage extends BaseFileStorage<BookmarkListData> {
  protected getFileName(): string {
    return 'bookmarks-private.json';
  }

  protected getDefaultData(): BookmarkListData {
    return { items: [], lastModified: Math.floor(Date.now() / 1000) };
  }

  protected getLoggerName(): string {
    return 'LegacyPrivateBookmarkStorage';
  }

  // Override to skip file creation - read-only for migration
  protected override async ensureFileExists(): Promise<void> {
    // Do nothing - never create legacy files
  }
}

/**
 * BookmarkFileStorage - Unified storage using new BookmarkSetData format
 */
export class BookmarkFileStorage {
  private static instance: BookmarkFileStorage;
  private storage: BookmarkSetStorage;
  private legacyPublic: LegacyPublicBookmarkStorage;
  private legacyPrivate: LegacyPrivateBookmarkStorage;
  private migrated = false;

  private constructor() {
    this.storage = new BookmarkSetStorage();
    this.legacyPublic = new LegacyPublicBookmarkStorage();
    this.legacyPrivate = new LegacyPrivateBookmarkStorage();
  }

  public static getInstance(): BookmarkFileStorage {
    if (!BookmarkFileStorage.instance) {
      BookmarkFileStorage.instance = new BookmarkFileStorage();
    }
    return BookmarkFileStorage.instance;
  }

  /**
   * Initialize storage and migrate if needed
   */
  public async initialize(): Promise<void> {
    await this.storage.initialize();

    // Check if we need to migrate from legacy files
    if (!this.migrated) {
      await this.migrateFromLegacyIfNeeded();
      this.migrated = true;
    }
  }

  /**
   * Migrate from legacy two-file format to new single-file format
   */
  private async migrateFromLegacyIfNeeded(): Promise<void> {
    try {
      await this.legacyPublic.initialize();
      await this.legacyPrivate.initialize();

      const publicData = await this.legacyPublic.read();
      const privateData = await this.legacyPrivate.read();

      // Check if legacy files have data
      const hasLegacyData = publicData.items.length > 0 || privateData.items.length > 0;

      if (hasLegacyData) {
        // Check if new file is empty or doesn't exist
        const currentData = await this.storage.read();
        const newFileEmpty = currentData.sets.length <= 1 &&
          currentData.sets[0]?.publicTags.length === 0 &&
          currentData.sets[0]?.privateTags.length === 0;

        if (newFileEmpty) {
          // Merge legacy data and migrate
          const mergedLegacy: BookmarkListData = {
            items: [
              ...publicData.items.map(i => ({ ...i, isPrivate: false })),
              ...privateData.items.map(i => ({ ...i, isPrivate: true }))
            ],
            folders: publicData.folders,
            folderAssignments: publicData.folderAssignments,
            rootOrder: publicData.rootOrder,
            lastModified: Math.max(publicData.lastModified, privateData.lastModified)
          };

          const migrated = migrateFromOldFormat(mergedLegacy);
          await this.storage.write(migrated);

          console.log('[BookmarkFileStorage] Migrated from legacy two-file format');
        }
      }
    } catch (e) {
      // Legacy files don't exist or can't be read, that's fine
      console.log('[BookmarkFileStorage] No legacy files to migrate');
    }
  }

  /**
   * Read bookmark data (new format)
   */
  public async read(): Promise<BookmarkSetData> {
    // Ensure initialization (triggers legacy migration if needed)
    await this.initialize();
    return await this.storage.read();
  }

  /**
   * Write bookmark data (new format)
   */
  public async write(data: BookmarkSetData): Promise<void> {
    // Ensure initialization
    await this.initialize();
    data.metadata.lastModified = Math.floor(Date.now() / 1000);
    await this.storage.write(data);
  }

  // ===== Legacy API for backward compatibility =====

  /**
   * Read public bookmark list (legacy API)
   * @deprecated Use read() instead
   */
  public async readPublic(): Promise<BookmarkListData> {
    const data = await this.read();
    return this.setDataToLegacyFormat(data, false);
  }

  /**
   * Read private bookmark list (legacy API)
   * @deprecated Use read() instead
   */
  public async readPrivate(): Promise<BookmarkListData> {
    const data = await this.read();
    return this.setDataToLegacyFormat(data, true);
  }

  /**
   * Write public bookmark list (legacy API)
   * @deprecated Use write() instead
   */
  public async writePublic(data: BookmarkListData): Promise<void> {
    // Read current data, update public items, write back
    const currentData = await this.read();

    // Remove all public items from all sets
    for (const set of currentData.sets) {
      set.publicTags = [];
    }

    // Add items from legacy format
    for (const item of data.items) {
      const assignment = data.folderAssignments?.find(a => a.bookmarkId === item.id);
      const folder = data.folders?.find(f => f.id === assignment?.folderId);
      const setName = folder?.name || '';

      let set = currentData.sets.find(s => s.d === setName);
      if (!set) {
        set = { kind: 30003, d: setName, title: setName, publicTags: [], privateTags: [] };  // d-tag = title-tag
        currentData.sets.push(set);
        currentData.metadata.setOrder.push(setName);
      }
      set.publicTags.push({ type: item.type, value: item.value });
    }

    await this.write(currentData);
  }

  /**
   * Write private bookmark list (legacy API)
   * @deprecated Use write() instead
   */
  public async writePrivate(data: BookmarkListData): Promise<void> {
    // Read current data, update private items, write back
    const currentData = await this.read();

    // Remove all private items from all sets
    for (const set of currentData.sets) {
      set.privateTags = [];
    }

    // Add items from legacy format
    for (const item of data.items) {
      const assignment = data.folderAssignments?.find(a => a.bookmarkId === item.id);
      const folder = data.folders?.find(f => f.id === assignment?.folderId);
      const setName = folder?.name || '';

      let set = currentData.sets.find(s => s.d === setName);
      if (!set) {
        set = { kind: 30003, d: setName, title: setName, publicTags: [], privateTags: [] };  // d-tag = title-tag
        currentData.sets.push(set);
        currentData.metadata.setOrder.push(setName);
      }
      set.privateTags.push({ type: item.type, value: item.value });
    }

    await this.write(currentData);
  }

  /**
   * Convert BookmarkSetData to legacy format
   */
  private setDataToLegacyFormat(data: BookmarkSetData, privateOnly: boolean): BookmarkListData {
    const items: BookmarkItem[] = [];
    const folders: BookmarkFolder[] = [];
    const folderAssignments: FolderAssignment[] = [];
    const rootOrder: RootOrderItem[] = [];

    // Build folders from sets (except root)
    let folderOrder = 0;
    for (const set of data.sets) {
      if (set.d !== '') {
        const folderId = `folder_${set.d}`;
        folders.push({
          id: folderId,
          name: set.d,
          createdAt: data.metadata.lastModified,
          order: folderOrder++
        });
        rootOrder.push({ type: 'folder', id: folderId });
      }
    }

    // Extract items
    let itemOrder = 0;
    for (const set of data.sets) {
      const tags = privateOnly ? set.privateTags : set.publicTags;
      const folderId = set.d === '' ? '' : `folder_${set.d}`;

      for (const tag of tags) {
        const item: BookmarkItem = {
          id: tag.value,
          type: tag.type,
          value: tag.value,
          addedAt: data.metadata.lastModified,
          isPrivate: privateOnly
        };
        items.push(item);

        folderAssignments.push({
          bookmarkId: tag.value,
          folderId,
          order: itemOrder++
        });

        if (set.d === '') {
          rootOrder.push({ type: 'bookmark', id: tag.value });
        }
      }
    }

    return {
      items,
      folders,
      folderAssignments,
      rootOrder,
      lastModified: data.metadata.lastModified
    };
  }

  /**
   * Get folder data for ALL bookmarks (public AND private)
   * Used by restoreFolderDataFromFile to restore folder assignments correctly
   */
  public async getAllFolderData(): Promise<{
    folders: BookmarkFolder[];
    folderAssignments: FolderAssignment[];
    rootOrder: RootOrderItem[];
  }> {
    const data = await this.read();

    const folders: BookmarkFolder[] = [];
    const folderAssignments: FolderAssignment[] = [];
    const rootOrder: RootOrderItem[] = [];

    // Build folders from sets (except root)
    let folderOrder = 0;
    for (const set of data.sets) {
      if (set.d !== '') {
        const folderId = `folder_${set.d}`;
        folders.push({
          id: folderId,
          name: set.d,
          createdAt: data.metadata.lastModified,
          order: folderOrder++
        });
        rootOrder.push({ type: 'folder', id: folderId });
      }
    }

    // Extract folder assignments for ALL items (public AND private)
    for (const set of data.sets) {
      const folderId = set.d === '' ? '' : `folder_${set.d}`;
      let itemOrder = 0;  // Reset order for each folder

      // Process public tags
      for (const tag of set.publicTags) {
        folderAssignments.push({
          bookmarkId: tag.value,
          folderId,
          order: itemOrder++
        });
        if (set.d === '') {
          rootOrder.push({ type: 'bookmark', id: tag.value });
        }
      }

      // Process private tags
      for (const tag of set.privateTags) {
        folderAssignments.push({
          bookmarkId: tag.value,
          folderId,
          order: itemOrder++
        });
        if (set.d === '') {
          rootOrder.push({ type: 'bookmark', id: tag.value });
        }
      }
    }

    return { folders, folderAssignments, rootOrder };
  }

  /**
   * Get all bookmarks with category info
   */
  public async getAllBookmarks(): Promise<BookmarkItem[]> {
    const data = await this.read();
    const items: BookmarkItem[] = [];

    for (const set of data.sets) {
      const category = set.d;  // d-tag = category

      // Add public items
      for (const tag of set.publicTags) {
        if (!items.some(i => i.value === tag.value)) {
          items.push({
            id: tag.value,
            type: tag.type,
            value: tag.value,
            addedAt: data.metadata.lastModified,
            isPrivate: false,
            category,
            description: tag.description
          });
        }
      }
      // Add private items
      for (const tag of set.privateTags) {
        if (!items.some(i => i.value === tag.value)) {
          items.push({
            id: tag.value,
            type: tag.type,
            value: tag.value,
            addedAt: data.metadata.lastModified,
            isPrivate: true,
            category,
            description: tag.description
          });
        }
      }
    }

    return items;
  }

  /**
   * Check if item is bookmarked
   */
  public async isBookmarked(id: string): Promise<{ public: boolean; private: boolean }> {
    const data = await this.read();
    let isPublic = false;
    let isPrivate = false;

    for (const set of data.sets) {
      if (set.publicTags.some(t => t.value === id)) isPublic = true;
      if (set.privateTags.some(t => t.value === id)) isPrivate = true;
    }

    return { public: isPublic, private: isPrivate };
  }

  /**
   * Get file path
   */
  public getFilePath(): string | null {
    return this.storage.getFilePath();
  }
}
