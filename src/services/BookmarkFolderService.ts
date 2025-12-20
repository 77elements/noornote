/**
 * BookmarkFolderService
 * Manages bookmark folders (categories) and item-to-folder assignments
 *
 * Storage Strategy:
 * - Uses PerAccountLocalStorage for per-account isolation
 * - Folders, assignments, and root order are all per-account
 *
 * NIP-51 Future:
 * - Kind 30003 = Bookmark Sets (each folder = one event)
 * - Tag order in event = item order in folder
 *
 * @purpose Folder CRUD, item assignment, ordering
 * @used-by BookmarkSecondaryManager
 */

import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';

export interface BookmarkFolder {
  id: string;           // Unique identifier (will be d-tag in NIP-51)
  name: string;         // Display name (will be title-tag in NIP-51)
  createdAt: number;    // Timestamp
  order: number;        // Position in root view
}

export interface FolderAssignment {
  bookmarkId: string;   // Event ID
  folderId: string;     // Folder ID (empty string = root)
  order: number;        // Position within folder/root
}

export interface RootOrderItem {
  type: 'folder' | 'bookmark';
  id: string;
}

export class BookmarkFolderService {
  private static instance: BookmarkFolderService;
  private storage: PerAccountLocalStorage;

  private constructor() {
    this.storage = PerAccountLocalStorage.getInstance();
  }

  public static getInstance(): BookmarkFolderService {
    if (!BookmarkFolderService.instance) {
      BookmarkFolderService.instance = new BookmarkFolderService();
    }
    return BookmarkFolderService.instance;
  }

  // ========================================
  // Folder CRUD
  // ========================================

  public getFolders(): BookmarkFolder[] {
    const folders = this.storage.get<BookmarkFolder[]>(StorageKeys.BOOKMARK_FOLDERS, []);
    return folders.sort((a, b) => a.order - b.order);
  }

  public getFolder(folderId: string): BookmarkFolder | null {
    const folders = this.getFolders();
    return folders.find(f => f.id === folderId) || null;
  }

  public createFolder(name: string): BookmarkFolder {
    const folders = this.getFolders();

    // Generate unique ID
    const id = `folder_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // Get max order for new folder
    const maxOrder = folders.reduce((max, f) => Math.max(max, f.order), -1);

    const folder: BookmarkFolder = {
      id,
      name,
      createdAt: Math.floor(Date.now() / 1000),
      order: maxOrder + 1
    };

    folders.push(folder);
    this.saveFolders(folders);

    return folder;
  }

  public renameFolder(folderId: string, newName: string): void {
    const folders = this.getFolders();
    const folder = folders.find(f => f.id === folderId);
    if (folder) {
      folder.name = newName;
      this.saveFolders(folders);
    }
  }

  public deleteFolder(folderId: string): string[] {
    // Get all bookmarks in this folder before deletion
    const assignments = this.getAssignments();
    const affectedBookmarkIds = assignments
      .filter(a => a.folderId === folderId)
      .map(a => a.bookmarkId);

    // Move all bookmarks from folder to root
    const updatedAssignments = assignments.map(a => {
      if (a.folderId === folderId) {
        return { ...a, folderId: '' };
      }
      return a;
    });
    this.saveAssignments(updatedAssignments);

    // Re-order root items
    this.reorderItems('');

    // Delete folder
    const folders = this.getFolders().filter(f => f.id !== folderId);
    this.saveFolders(folders);

    return affectedBookmarkIds;
  }

  private saveFolders(folders: BookmarkFolder[]): void {
    this.storage.set(StorageKeys.BOOKMARK_FOLDERS, folders);
  }

  // ========================================
  // Bookmark-to-Folder Assignments
  // ========================================

  private getAssignments(): FolderAssignment[] {
    return this.storage.get<FolderAssignment[]>(StorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS, []);
  }

  private saveAssignments(assignments: FolderAssignment[]): void {
    this.storage.set(StorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS, assignments);
  }

  public getBookmarkFolder(bookmarkId: string): string {
    const assignments = this.getAssignments();
    const assignment = assignments.find(a => a.bookmarkId === bookmarkId);
    return assignment?.folderId || '';
  }

  public getBookmarksInFolder(folderId: string): string[] {
    const assignments = this.getAssignments();
    return assignments
      .filter(a => a.folderId === folderId)
      .sort((a, b) => a.order - b.order)
      .map(a => a.bookmarkId);
  }

  public getFolderItemCount(folderId: string): number {
    const assignments = this.getAssignments();
    return assignments.filter(a => a.folderId === folderId).length;
  }

  public moveBookmarkToFolder(bookmarkId: string, targetFolderId: string, explicitOrder?: number): void {
    const assignments = this.getAssignments();
    const existing = assignments.find(a => a.bookmarkId === bookmarkId);

    if (existing) {
      const oldFolderId = existing.folderId;
      existing.folderId = targetFolderId;

      if (explicitOrder !== undefined) {
        existing.order = explicitOrder;
      } else {
        // Get max order in target folder
        const maxOrder = assignments
          .filter(a => a.folderId === targetFolderId && a.bookmarkId !== bookmarkId)
          .reduce((max, a) => Math.max(max, a.order), -1);
        existing.order = maxOrder + 1;
      }

      this.saveAssignments(assignments);

      // Reorder old folder
      this.reorderItems(oldFolderId);
    } else {
      // Create new assignment
      const order = explicitOrder !== undefined
        ? explicitOrder
        : assignments
            .filter(a => a.folderId === targetFolderId)
            .reduce((max, a) => Math.max(max, a.order), -1) + 1;

      assignments.push({
        bookmarkId,
        folderId: targetFolderId,
        order
      });
      this.saveAssignments(assignments);
    }
  }

  public ensureBookmarkAssignment(bookmarkId: string, explicitOrder?: number): void {
    const assignments = this.getAssignments();
    const existing = assignments.find(a => a.bookmarkId === bookmarkId);

    if (!existing) {
      // Add to root with specified order or next available
      const order = explicitOrder !== undefined
        ? explicitOrder
        : assignments
            .filter(a => a.folderId === '')
            .reduce((max, a) => Math.max(max, a.order), -1) + 1;

      assignments.push({
        bookmarkId,
        folderId: '',
        order
      });
      this.saveAssignments(assignments);
    }
  }

  public removeBookmarkAssignment(bookmarkId: string): void {
    const assignments = this.getAssignments().filter(a => a.bookmarkId !== bookmarkId);
    this.saveAssignments(assignments);
  }

  // ========================================
  // Ordering
  // ========================================

  public reorderItems(folderId: string): void {
    const assignments = this.getAssignments();
    const itemsInFolder = assignments
      .filter(a => a.folderId === folderId)
      .sort((a, b) => a.order - b.order);

    // Renumber to fill gaps
    itemsInFolder.forEach((item, index) => {
      item.order = index;
    });

    this.saveAssignments(assignments);
  }

  public moveItemToPosition(bookmarkId: string, newOrder: number): void {
    const assignments = this.getAssignments();
    const item = assignments.find(a => a.bookmarkId === bookmarkId);
    if (!item) return;

    const folderId = item.folderId;
    const itemsInFolder = assignments
      .filter(a => a.folderId === folderId)
      .sort((a, b) => a.order - b.order);

    // Remove from current position
    const currentIndex = itemsInFolder.findIndex(a => a.bookmarkId === bookmarkId);
    if (currentIndex === -1) return;

    itemsInFolder.splice(currentIndex, 1);

    // Insert at new position
    const insertIndex = Math.min(newOrder, itemsInFolder.length);
    itemsInFolder.splice(insertIndex, 0, item);

    // Renumber all
    itemsInFolder.forEach((a, index) => {
      a.order = index;
    });

    this.saveAssignments(assignments);
  }

  public moveFolderToPosition(folderId: string, newOrder: number): void {
    const folders = this.getFolders();
    const folder = folders.find(f => f.id === folderId);
    if (!folder) return;

    // Remove from current position
    const currentIndex = folders.findIndex(f => f.id === folderId);
    if (currentIndex === -1) return;

    folders.splice(currentIndex, 1);

    // Insert at new position
    const insertIndex = Math.min(newOrder, folders.length);
    folders.splice(insertIndex, 0, folder);

    // Renumber all
    folders.forEach((f, index) => {
      f.order = index;
    });

    this.saveFolders(folders);
  }

  // ========================================
  // Root-level ordering (mixed folders + bookmarks)
  // ========================================

  public hasRootOrder(): boolean {
    const order = this.storage.get<RootOrderItem[]>(StorageKeys.BOOKMARK_ROOT_ORDER, []);
    return order.length > 0;
  }

  public clearRootOrder(): void {
    this.storage.remove(StorageKeys.BOOKMARK_ROOT_ORDER);
  }

  public clearAssignments(): void {
    this.storage.remove(StorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS);
  }

  public getRootOrder(): RootOrderItem[] {
    const order = this.storage.get<RootOrderItem[]>(StorageKeys.BOOKMARK_ROOT_ORDER, []);
    if (order.length === 0) {
      // Build initial order from existing data
      return this.buildInitialRootOrder();
    }
    return order;
  }

  private buildInitialRootOrder(): RootOrderItem[] {
    const folders = this.getFolders();
    const rootBookmarkIds = this.getBookmarksInFolder('');

    const order: RootOrderItem[] = [];

    // Add bookmarks in reverse order (newest first) for initial display
    // User can reorder later via drag & drop
    const reversedBookmarkIds = [...rootBookmarkIds].reverse();
    reversedBookmarkIds.forEach(id => {
      order.push({ type: 'bookmark', id });
    });

    // Add folders
    folders.forEach(f => {
      order.push({ type: 'folder', id: f.id });
    });

    this.saveRootOrder(order);
    return order;
  }

  public saveRootOrder(order: RootOrderItem[]): void {
    this.storage.set(StorageKeys.BOOKMARK_ROOT_ORDER, order);
  }

  public addToRootOrder(type: 'folder' | 'bookmark', id: string): void {
    const order = this.getRootOrder();
    // Check if already exists
    if (!order.some(item => item.type === type && item.id === id)) {
      // Add at beginning (newest first)
      order.unshift({ type, id });
      this.saveRootOrder(order);
    }
  }

  public removeFromRootOrder(type: 'folder' | 'bookmark', id: string): void {
    const order = this.getRootOrder().filter(
      item => !(item.type === type && item.id === id)
    );
    this.saveRootOrder(order);
  }

  public moveInRootOrder(type: 'folder' | 'bookmark', id: string, newIndex: number): void {
    const order = this.getRootOrder();
    const currentIndex = order.findIndex(item => item.type === type && item.id === id);

    if (currentIndex === -1) return;

    const [item] = order.splice(currentIndex, 1);
    const insertIndex = Math.min(newIndex, order.length);
    order.splice(insertIndex, 0, item);

    this.saveRootOrder(order);
  }

  // ========================================
  // Cleanup
  // ========================================

  /**
   * Remove orphaned assignments (assignments referencing non-existent bookmarks)
   * Returns the number of removed orphans
   */
  public cleanupOrphanedAssignments(): number {
    // Get existing bookmark IDs from storage
    const bookmarkItems = this.storage.get<{ id: string }[]>(StorageKeys.BOOKMARKS, []);
    const existingBookmarkIds = new Set(bookmarkItems.map(item => item.id));

    // Get all assignments
    const assignments = this.getAssignments();
    const originalCount = assignments.length;

    // Filter to keep only assignments with existing bookmarks
    const cleanedAssignments = assignments.filter(a => existingBookmarkIds.has(a.bookmarkId));

    const removedCount = originalCount - cleanedAssignments.length;

    if (removedCount > 0) {
      this.saveAssignments(cleanedAssignments);
    }

    return removedCount;
  }

  // ========================================
  // Sync helpers (for future NIP-51 integration)
  // ========================================

  public exportFolderAsNip51(folderId: string): {
    dTag: string;
    titleTag: string;
    bookmarkIds: string[];
  } {
    const folder = this.getFolder(folderId);
    if (!folder) throw new Error(`Folder not found: ${folderId}`);

    const bookmarkIds = this.getBookmarksInFolder(folderId);

    return {
      dTag: folder.id,
      titleTag: folder.name,
      bookmarkIds
    };
  }
}
