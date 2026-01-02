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

    // Publish folder order metadata (NIP-78 kind:30078)
    const folderOrder = setData.metadata.setOrder.filter(d => d !== '');
    if (folderOrder.length > 0) {
      const orderTags: string[][] = [
        ['d', 'noornote:bookmark-folders-order']
      ];

      for (const dTag of folderOrder) {
        const coordinate = `30003:${currentUser.pubkey}:${dTag}`;
        orderTags.push(['a', coordinate]);
      }

      const orderEvent = {
        kind: 30078,
        created_at: Math.floor(Date.now() / 1000),
        tags: orderTags,
        content: '',
        pubkey: currentUser.pubkey
      };

      const signedOrderEvent = await this.authService.signEvent(orderEvent);
      if (signedOrderEvent) {
        await this.transport.publish(writeRelays, signedOrderEvent);
        this.systemLogger.info('BookmarkOrchestrator',
          `Published folder order metadata (kind:30078) with ${folderOrder.length} folders`
        );
      }
    }
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

    // Build setOrder from rootOrder (preserves user's drag & drop arrangement)
    const rootOrder = this.folderService.getRootOrder();
    const folderNames: string[] = [];
    for (const item of rootOrder) {
      if (item.type === 'folder') {
        const folder = existingFolders.find(f => f.id === item.id);
        if (folder) {
          folderNames.push(folder.name);
        }
      }
    }
    const setOrder = ['', ...folderNames];

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

      // Fetch folder order metadata (NIP-78 kind:30078)
      const orderEvents = await this.transport.fetch(relays, [{
        authors: [pubkey],
        kinds: [30078],
        "#d": ["noornote:bookmark-folders-order"]
      }], 5000);

      let folderOrder: string[] = [];
      if (orderEvents.length > 0) {
        const orderEvent = orderEvents.sort((a, b) => b.created_at - a.created_at)[0];
        folderOrder = orderEvent.tags
          .filter(t => t[0] === 'a' && t[1]?.startsWith('30003:'))
          .map(t => {
            const parts = t[1].split(':');
            return parts[2] || '';
          });

        this.systemLogger.info('BookmarkOrchestrator',
          `Loaded folder order from NIP-78 metadata: ${folderOrder.join(', ')}`
        );
      }

      // Build categories array in correct order
      const categories: string[] = [''];  // Root always first

      if (folderOrder.length > 0) {
        // Use order from NIP-78 metadata
        for (const dTag of folderOrder) {
          if (eventsByDTag.has(dTag)) {
            categories.push(dTag);
          }
        }

        // Add any folders not in metadata (edge case)
        for (const dTag of eventsByDTag.keys()) {
          if (dTag !== '' && !categories.includes(dTag)) {
            categories.push(dTag);
            this.systemLogger.warn('BookmarkOrchestrator',
              `Folder "${dTag}" not in order metadata, appending to end`
            );
          }
        }
      } else {
        // Fallback: alphabetical order
        const sortedDTags = Array.from(eventsByDTag.keys())
          .filter(d => d !== '')
          .sort();
        categories.push(...sortedDTags);

        this.systemLogger.info('BookmarkOrchestrator',
          'No folder order metadata found, using alphabetical fallback'
        );
      }

      const allItems: BookmarkItem[] = [];
      const categoryAssignments = new Map<string, string>(); // bookmarkId -> categoryName
      let anyContentWasEmpty = true;

      for (const categoryName of categories) {
        const event = eventsByDTag.get(categoryName);
        if (!event) continue;

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
   * Fetch bookmarks from relays (read-only wrapper)
   */
  public async fetchBookmarksFromRelays(pubkey: string): Promise<FetchFromRelaysResult<BookmarkItem>> {
    return await this.fetchFromRelays(pubkey);
  }
}
