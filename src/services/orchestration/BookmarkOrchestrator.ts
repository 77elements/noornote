/**
 * @orchestrator BookmarkOrchestrator
 * @purpose Manages bookmarks (kind:30003 Bookmark Sets) with NIP-51 category support
 * @used-by NoteMenu, BookmarksTab
 *
 * NIP-51 Bookmark Sets Architecture:
 * - Each category (folder) = one kind:30003 event with d-tag = category name
 * - Root bookmarks (no folder) = kind:30003 with d-tag = ""
 * - Private bookmarks = encrypted in content of respective category event
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { BookmarkItem } from '../storage/BookmarkFileStorage';
import { BookmarkFileStorage } from '../storage/BookmarkFileStorage';
import type { FetchFromRelaysResult } from '../sync/ListStorageAdapter';
import type { BookmarkSetData, BookmarkSet } from '../../types/BookmarkSetData';
import { GenericListOrchestrator } from './GenericListOrchestrator';
import { bookmarkListConfig, createBookmarkFileStorageWrapper } from './configs/BookmarkListConfig';
import { BookmarkFolderService } from '../BookmarkFolderService';
import { toNostrEvents } from '../sync/serializers/BookmarkSerializer';

// Re-export BookmarkItem for external use
export type { BookmarkItem };

export interface BookmarkStatus {
  public: boolean;
  private: boolean;
}

export interface BookmarkWithMetadata {
  id: string;
  isPrivate: boolean;
  category?: string;  // d-tag value (folder name)
}

export class BookmarkOrchestrator extends GenericListOrchestrator<BookmarkItem> {
  private static instance: BookmarkOrchestrator;
  private featureFlagKey = 'noornote_nip51_private_bookmarks_enabled';
  private folderService: BookmarkFolderService;

  private constructor() {
    super('BookmarkOrchestrator', bookmarkListConfig, createBookmarkFileStorageWrapper());
    this.folderService = BookmarkFolderService.getInstance();
  }

  public static getInstance(): BookmarkOrchestrator {
    if (!BookmarkOrchestrator.instance) {
      BookmarkOrchestrator.instance = new BookmarkOrchestrator();
    }
    return BookmarkOrchestrator.instance;
  }

  // Required Orchestrator abstract methods
  public override onui(_data: any): void {}
  public override onopen(_relay: string): void {}
  public override onmessage(_relay: string, _event: NostrEvent): void {}
  public override onerror(_relay: string, _error: Error): void {}
  public override onclose(_relay: string): void {}

  /**
   * Check if NIP-51 private bookmarks feature is enabled
   */
  public isPrivateBookmarksEnabled(): boolean {
    try {
      const stored = localStorage.getItem(this.featureFlagKey);
      return stored === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Enable/disable NIP-51 private bookmarks feature
   */
  public setPrivateBookmarksEnabled(enabled: boolean): void {
    try {
      localStorage.setItem(this.featureFlagKey, enabled.toString());
    } catch (error) {
      this.systemLogger.error('BookmarkOrchestrator', `Failed to save NIP-51 private bookmarks flag: ${error}`);
    }
  }

  /**
   * Check if a note is bookmarked (public, private, or both)
   * Reads from browserItems (localStorage)
   */
  public async isBookmarked(noteId: string, _pubkey: string): Promise<BookmarkStatus> {
    try {
      const browserItems = this.getBrowserItems();
      const item = browserItems.find(b => b.id === noteId);

      if (!item) {
        return { public: false, private: false };
      }

      if (item.isPrivate) {
        return { public: false, private: true };
      } else {
        return { public: true, private: false };
      }
    } catch (error) {
      this.systemLogger.error('BookmarkOrchestrator', `Failed to check bookmark status: ${error}`);
      return { public: false, private: false };
    }
  }

  /**
   * Add a bookmark (public or private)
   * Writes to browserItems (localStorage)
   */
  public async addBookmark(noteId: string, isPrivate: boolean, category: string = ''): Promise<boolean> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    try {
      const browserItems = this.getBrowserItems();

      if (browserItems.some(b => b.id === noteId)) {
        return true; // Already bookmarked
      }

      const item: BookmarkItem = {
        id: noteId,
        type: 'e',
        value: noteId,
        addedAt: Math.floor(Date.now() / 1000),
        isPrivate: isPrivate,
        category: category
      };

      await this.addItem(item);

      // Keep folderService in sync for UI
      this.folderService.ensureBookmarkAssignment(noteId);

      this.systemLogger.info('BookmarkOrchestrator',
        `Added ${isPrivate ? 'private' : 'public'} bookmark to "${category || 'root'}": ${noteId}`
      );

      this.eventBus.emit('bookmark:updated', {});
      return true;
    } catch (error) {
      this.systemLogger.error('BookmarkOrchestrator', `Failed to add bookmark: ${error}`);
      throw error;
    }
  }

  /**
   * Remove a bookmark (public or private)
   * Writes to browserItems (localStorage)
   */
  public async removeBookmark(noteId: string, _isPrivate: boolean): Promise<boolean> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    try {
      await this.removeItem(noteId);

      // Remove folder assignment
      this.folderService.removeBookmarkAssignment(noteId);

      this.systemLogger.info('BookmarkOrchestrator', `Removed bookmark (local): ${noteId}`);

      this.eventBus.emit('bookmark:updated', {});
      return true;
    } catch (error) {
      this.systemLogger.error('BookmarkOrchestrator', `Failed to remove bookmark: ${error}`);
      throw error;
    }
  }

  /**
   * Get all bookmarks with their status (public/private/both)
   */
  public async getAllBookmarksWithStatus(): Promise<Map<string, { public: boolean; private: boolean }>> {
    try {
      const browserItems = this.getBrowserItems();
      const result = new Map<string, { public: boolean; private: boolean }>();

      browserItems.forEach(item => {
        if (item.isPrivate) {
          result.set(item.id, { public: false, private: true });
        } else {
          result.set(item.id, { public: true, private: false });
        }
      });

      return result;
    } catch (error) {
      this.systemLogger.error('BookmarkOrchestrator', `Failed to get bookmarks with status: ${error}`);
      return new Map();
    }
  }

  /**
   * Get all bookmarks (merged public + private), sorted chronologically
   * Reads from browserItems (localStorage)
   */
  public async getAllBookmarks(_pubkey: string): Promise<string[]> {
    try {
      const browserItems = this.getBrowserItems();

      // If empty, try to load from files
      if (browserItems.length === 0) {
        const fileItems = await this.fileStorage.getAllItems();
        if (fileItems.length > 0) {
          this.setBrowserItems(fileItems);
          return fileItems.map(item => item.id);
        }
      }

      const bookmarkIds = browserItems.map(item => item.id);

      this.systemLogger.info('BookmarkOrchestrator',
        `Loaded ${bookmarkIds.length} bookmarks from browserItems`
      );

      return bookmarkIds;
    } catch (error) {
      this.systemLogger.error('BookmarkOrchestrator', `Failed to fetch bookmarks: ${error}`);
      return [];
    }
  }

  /**
   * Get all bookmarks with metadata (public/private indicator)
   */
  public async getAllBookmarksWithMetadata(_pubkey: string): Promise<BookmarkWithMetadata[]> {
    try {
      const browserItems = this.getBrowserItems();

      // If empty, try to load from files
      if (browserItems.length === 0) {
        const fileItems = await this.fileStorage.getAllItems();
        if (fileItems.length > 0) {
          this.setBrowserItems(fileItems);
          return fileItems.map(item => ({
            id: item.id,
            isPrivate: item.isPrivate || false
          }));
        }
      }

      const result = browserItems.map(item => ({
        id: item.id,
        isPrivate: item.isPrivate || false
      }));

      this.systemLogger.info('BookmarkOrchestrator',
        `Loaded ${result.length} bookmarks with metadata from browserItems`
      );

      return result;
    } catch (error) {
      this.systemLogger.error('BookmarkOrchestrator', `Failed to fetch bookmarks: ${error}`);
      return [];
    }
  }

  // ===== File & Relay Sync =====

  /**
   * Save to file (override to use BookmarkSetData format)
   */
  public override async saveToFile(): Promise<void> {
    const setData = this.buildSetDataFromLocalStorage();
    const storage = BookmarkFileStorage.getInstance();
    await storage.write(setData);

    this.systemLogger.info('BookmarkOrchestrator',
      `Saved to file: ${setData.sets.length} sets`
    );
  }

  /**
   * Publish to relays (manual sync via UI button)
   * Uses BookmarkSerializer for consistent format
   *
   * NIP-51 Bookmark Sets:
   * - Root bookmarks → d: ""
   * - Category "Work" → d: "Work"
   * - Private bookmarks → encrypted in content
   * - Deleted categories → publish empty event to overwrite
   */
  public override async publishToRelays(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) {
      throw new Error('No write relays available');
    }

    // Build BookmarkSetData from localStorage
    const setData = this.buildSetDataFromLocalStorage();
    const localCategories = new Set(setData.sets.map(s => s.d));

    // Fetch existing categories from relays to find deleted ones
    const relayResult = await this.fetchFromRelays(currentUser.pubkey);
    const relayCategories = new Set(relayResult.categories || []);

    // Find categories that exist on relays but not locally (deleted)
    const deletedCategories: string[] = [];
    for (const relayCategory of relayCategories) {
      if (!localCategories.has(relayCategory)) {
        deletedCategories.push(relayCategory);
      }
    }

    this.systemLogger.info('BookmarkOrchestrator',
      `Publishing: ${setData.sets.length} sets, ${deletedCategories.length} deleted categories`
    );

    // First, publish empty events for deleted categories
    for (const categoryName of deletedCategories) {
      await this.publishEmptyCategory(categoryName);
    }

    // Convert to Nostr events using serializer
    const events = await toNostrEvents(
      setData,
      currentUser.pubkey,
      async (tags, pubkey) => {
        // Convert BookmarkTag[] to BookmarkItem[] for encryption
        const items: BookmarkItem[] = tags.map(tag => ({
          id: tag.value,
          type: tag.type,
          value: tag.value,
          isPrivate: true
        }));
        return await this.encryptPrivateItems(items, pubkey);
      }
    );

    // Publish each event
    let totalPublished = 0;

    for (let i = 0; i < events.length; i++) {
      const { tags, content } = events[i];
      const set = setData.sets[i];

      // Skip empty sets (except root)
      if (set.publicTags.length === 0 && set.privateTags.length === 0 && set.d !== '') {
        continue;
      }

      const event = {
        kind: 30003,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content,
        pubkey: currentUser.pubkey
      };

      const signed = await this.authService.signEvent(event);
      if (!signed) {
        this.systemLogger.error('BookmarkOrchestrator', `Failed to sign event for category: ${set.d}`);
        continue;
      }

      await this.transport.publish(writeRelays, signed);
      totalPublished++;

      this.systemLogger.info('BookmarkOrchestrator',
        `Published category "${set.d || 'root'}": ${set.publicTags.length} public + ${set.privateTags.length} private`
      );
    }

    this.systemLogger.info('BookmarkOrchestrator',
      `Published ${totalPublished} bookmark set events + ${deletedCategories.length} deletions to relays`
    );
  }

  /**
   * Publish an empty event for a category to "delete" it from relays
   * This overwrites the existing event with an empty one
   */
  public async publishEmptyCategory(categoryName: string): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) {
      throw new Error('No write relays available');
    }

    // Build empty event with this d-tag
    const tags: string[][] = [
      ['d', categoryName],
      ['title', categoryName],
      ['client', 'NoorNote']
    ];

    const event = {
      kind: 30003,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
      pubkey: currentUser.pubkey
    };

    const signed = await this.authService.signEvent(event);
    if (!signed) {
      throw new Error(`Failed to sign empty event for category: ${categoryName}`);
    }

    await this.transport.publish(writeRelays, signed);

    this.systemLogger.info('BookmarkOrchestrator',
      `Published empty event to delete category "${categoryName}" from relays`
    );
  }

  /**
   * Build BookmarkSetData from localStorage with CORRECT ORDER from FolderService
   * Uses FolderService.getBookmarksInFolder() to preserve user's manual ordering
   */
  private buildSetDataFromLocalStorage(): BookmarkSetData {
    const allItems = this.getBrowserItems();

    // Build item lookup map (id -> item)
    const itemMap = new Map<string, BookmarkItem>();
    for (const item of allItems) {
      itemMap.set(item.id, item);
    }

    // Create sets map
    const setsMap = new Map<string, BookmarkSet>();

    // Initialize root set
    setsMap.set('', {
      kind: 30003,
      d: '',
      title: '',
      publicTags: [],
      privateTags: []
    });

    // Get all folders from FolderService
    const existingFolders = this.folderService.getFolders();

    // Create sets for each folder
    for (const folder of existingFolders) {
      setsMap.set(folder.name, {
        kind: 30003,
        d: folder.name,
        title: folder.name,
        publicTags: [],
        privateTags: []
      });
    }

    // Track which items have been assigned (to catch orphans)
    const assignedItemIds = new Set<string>();

    // Process each folder IN ORDER from FolderService
    for (const folder of existingFolders) {
      const set = setsMap.get(folder.name)!;
      // getBookmarksInFolder returns IDs sorted by order field
      const sortedBookmarkIds = this.folderService.getBookmarksInFolder(folder.id);

      for (const bookmarkId of sortedBookmarkIds) {
        const item = itemMap.get(bookmarkId);
        if (item) {
          const tag = { type: item.type, value: item.value, description: item.description };
          if (item.isPrivate) {
            set.privateTags.push(tag);
          } else {
            set.publicTags.push(tag);
          }
          assignedItemIds.add(bookmarkId);
        }
      }
    }

    // Process root items IN ORDER from FolderService
    const rootSet = setsMap.get('')!;
    const sortedRootBookmarkIds = this.folderService.getBookmarksInFolder('');

    for (const bookmarkId of sortedRootBookmarkIds) {
      const item = itemMap.get(bookmarkId);
      if (item) {
        const tag = { type: item.type, value: item.value, description: item.description };
        if (item.isPrivate) {
          rootSet.privateTags.push(tag);
        } else {
          rootSet.publicTags.push(tag);
        }
        assignedItemIds.add(bookmarkId);
      }
    }

    // Handle orphaned items (in browserItems but not in FolderService) - add to root
    for (const item of allItems) {
      if (!assignedItemIds.has(item.id)) {
        const tag = { type: item.type, value: item.value, description: item.description };
        if (item.isPrivate) {
          rootSet.privateTags.push(tag);
        } else {
          rootSet.publicTags.push(tag);
        }
        // Also ensure FolderService knows about this item
        this.folderService.ensureBookmarkAssignment(item.id);
      }
    }

    // Build setOrder (root first, then by folder order)
    const setOrder = ['', ...existingFolders.map(f => f.name)];

    return {
      version: 2,
      sets: Array.from(setsMap.values()),
      metadata: {
        setOrder,
        lastModified: Math.floor(Date.now() / 1000)
      }
    };
  }

  /**
   * Fetch bookmarks from relays (read-only, no local changes)
   * Fetches ALL kind:30003 events for the user and extracts categories
   */
  public override async fetchFromRelays(pubkey: string): Promise<FetchFromRelaysResult<BookmarkItem>> {
    const relays = this.getBootstrapRelays();

    try {
      // Fetch ALL kind:30003 events (all categories)
      const events = await this.transport.fetch(relays, [{
        authors: [pubkey],
        kinds: [30003],
        limit: 100  // Support up to 100 categories
      }], 10000);

      if (events.length === 0) {
        this.systemLogger.info('BookmarkOrchestrator', 'No bookmark sets found on relays');
        return { items: [], relayContentWasEmpty: true };
      }

      // Deduplicate by d-tag (keep newest per category)
      const eventsByDTag = new Map<string, NostrEvent>();
      events.forEach(event => {
        const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
        const existing = eventsByDTag.get(dTag);
        if (!existing || event.created_at > existing.created_at) {
          eventsByDTag.set(dTag, event);
        }
      });

      const allItems: BookmarkItem[] = [];
      const categoryAssignments = new Map<string, string>(); // bookmarkId -> categoryName
      const categories: string[] = [];
      let anyContentWasEmpty = true;

      for (const [categoryName, event] of eventsByDTag) {
        // Track all categories (including root "")
        categories.push(categoryName);

        const hasContent = event.content && event.content.trim() !== '';
        if (hasContent) anyContentWasEmpty = false;

        // Extract public items from tags (exclude d and title tags)
        const publicItems = this.config.tagsToItem(
          event.tags.filter(t => t[0] !== 'd' && t[0] !== 'title'),
          event.created_at
        );
        publicItems.forEach(item => {
          item.isPrivate = false;
          item.category = categoryName;  // Set category directly on item
          categoryAssignments.set(item.id, categoryName);
        });

        // Extract private items from encrypted content
        let privateItems: BookmarkItem[] = [];
        if (hasContent) {
          try {
            privateItems = await this.decryptPrivateItems(event, pubkey);
            privateItems.forEach(item => {
              item.isPrivate = true;
              item.category = categoryName;  // Set category directly on item
              categoryAssignments.set(item.id, categoryName);
            });
          } catch (error) {
            this.systemLogger.error('BookmarkOrchestrator',
              `Failed to decrypt private items for category "${categoryName}": ${error}`
            );
          }
        }

        allItems.push(...publicItems, ...privateItems);

        this.systemLogger.info('BookmarkOrchestrator',
          `Fetched category "${categoryName || 'root'}": ${publicItems.length} public + ${privateItems.length} private`
        );
      }

      // Deduplicate by ID
      const itemMap = new Map<string, BookmarkItem>();
      allItems.forEach(item => itemMap.set(this.config.getItemId(item), item));

      return {
        items: Array.from(itemMap.values()),
        relayContentWasEmpty: anyContentWasEmpty,
        categoryAssignments,
        categories
      };
    } catch (error) {
      this.systemLogger.error('BookmarkOrchestrator', `Failed to fetch from relays: ${error}`);
      return { items: [], relayContentWasEmpty: true };
    }
  }

  /**
   * Sync from relays (manual sync)
   * Fetches all categories and merges with local
   * Creates folders from relay categories and assigns bookmarks
   */
  public override async syncFromRelays(pubkey: string): Promise<{ added: number; total: number }> {
    const relays = this.getBootstrapRelays();
    this.systemLogger.info('BookmarkOrchestrator', `Syncing from relays (${relays.length} relays)...`);

    try {
      const fetchResult = await this.fetchFromRelays(pubkey);
      const localItems = this.getBrowserItems();

      // Merge (union)
      const merged = this.mergeItems(localItems, fetchResult.items);
      const added = merged.length - localItems.length;

      this.setBrowserItems(merged);

      // Create folders only for categories that have items (skip empty sets)
      const existingFolders = this.folderService.getFolders();
      const categoryAssignments = fetchResult.categoryAssignments;

      // Collect categories that actually have items
      const categoriesWithItems = new Set<string>();
      if (categoryAssignments) {
        for (const [, categoryName] of categoryAssignments) {
          if (categoryName !== '') {
            categoriesWithItems.add(categoryName);
          }
        }
      }

      for (const categoryName of categoriesWithItems) {
        // Check if folder with this name exists
        const existingFolder = existingFolders.find(f => f.name === categoryName);
        if (!existingFolder) {
          this.folderService.createFolder(categoryName);
          this.systemLogger.info('BookmarkOrchestrator', `Created folder from relay: "${categoryName}"`);
        }
      }

      // Assign bookmarks to their categories from relay, preserving order
      // BUG FIX: Only assign categories for NEW bookmarks (not in local storage before sync)
      // Existing bookmarks keep their local folder assignment - user's manual organization takes precedence
      if (categoryAssignments) {
        const updatedFolders = this.folderService.getFolders(); // Refresh after creating new folders

        // Build set of local bookmark IDs (before merge) for fast lookup
        const localBookmarkIds = new Set(localItems.map(item => item.id));

        // Track order per category (Map iteration preserves insertion order from relay)
        const orderByCategory = new Map<string, number>();

        for (const [bookmarkId, categoryName] of categoryAssignments) {
          const isNewBookmark = !localBookmarkIds.has(bookmarkId);

          // Get next order for this category
          const currentOrder = orderByCategory.get(categoryName) ?? 0;
          orderByCategory.set(categoryName, currentOrder + 1);

          if (isNewBookmark) {
            // NEW bookmark: assign relay category with preserved order
            if (categoryName === '') {
              this.folderService.ensureBookmarkAssignment(bookmarkId, currentOrder);
            } else {
              const folder = updatedFolders.find(f => f.name === categoryName);
              if (folder) {
                this.folderService.moveBookmarkToFolder(bookmarkId, folder.id, currentOrder);
              } else {
                // Folder doesn't exist locally, assign to root
                this.folderService.ensureBookmarkAssignment(bookmarkId);
                this.systemLogger.warn('BookmarkOrchestrator',
                  `Folder "${categoryName}" not found, assigned bookmark ${bookmarkId.slice(0, 8)}... to root`
                );
              }
            }
          }
          // EXISTING bookmark: Skip - keep local folder assignment
        }
      }

      this.systemLogger.info('BookmarkOrchestrator',
        `Sync complete: ${added} new items, ${categoriesWithItems.size} categories`
      );

      return { added, total: merged.length };
    } catch (error) {
      this.systemLogger.error('BookmarkOrchestrator', `Sync from relays failed: ${error}`);
      throw error;
    }
  }

  /**
   * Fetch bookmarks from relays (read-only wrapper)
   */
  public async fetchBookmarksFromRelays(pubkey: string): Promise<FetchFromRelaysResult<BookmarkItem>> {
    return await this.fetchFromRelays(pubkey);
  }
}
