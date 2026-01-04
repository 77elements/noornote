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
 * @pattern Wrapper around GenericFolderService
 */

import { GenericFolderService, type Folder, type RootOrderItem } from './GenericFolderService';
import { StorageKeys } from './PerAccountLocalStorage';

export interface BookmarkFolder extends Folder {}

export interface FolderAssignment {
  bookmarkId: string;   // Event ID
  folderId: string;     // Folder ID (empty string = root)
  order: number;        // Position within folder/root
}

export class BookmarkFolderService {
  private static instance: BookmarkFolderService;
  private genericService: GenericFolderService<'bookmarkId', 'bookmark'>;

  private constructor() {
    this.genericService = new GenericFolderService({
      folderStorageKey: StorageKeys.BOOKMARK_FOLDERS,
      assignmentStorageKey: StorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS,
      rootOrderStorageKey: StorageKeys.BOOKMARK_ROOT_ORDER,
      itemsStorageKey: StorageKeys.BOOKMARKS,
      itemType: 'bookmark',
      itemIdField: 'bookmarkId'
    });
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
    return this.genericService.getFolders();
  }

  public getFolder(folderId: string): BookmarkFolder | null {
    return this.genericService.getFolder(folderId);
  }

  public createFolder(name: string): BookmarkFolder {
    return this.genericService.createFolder(name);
  }

  public renameFolder(folderId: string, newName: string): void {
    this.genericService.renameFolder(folderId, newName);
  }

  public deleteFolder(folderId: string): string[] {
    return this.genericService.deleteFolder(folderId);
  }

  // ========================================
  // Bookmark-to-Folder Assignments
  // ========================================

  public getBookmarkFolder(bookmarkId: string): string {
    return this.genericService.getItemFolder(bookmarkId);
  }

  public getBookmarksInFolder(folderId: string): string[] {
    return this.genericService.getItemsInFolder(folderId);
  }

  public getFolderItemCount(folderId: string): number {
    return this.genericService.getFolderItemCount(folderId);
  }

  public moveBookmarkToFolder(bookmarkId: string, targetFolderId: string, explicitOrder?: number): void {
    this.genericService.moveItemToFolder(bookmarkId, targetFolderId, explicitOrder);
  }

  public ensureBookmarkAssignment(bookmarkId: string, explicitOrder?: number): void {
    this.genericService.ensureItemAssignment(bookmarkId, explicitOrder);
  }

  public removeBookmarkAssignment(bookmarkId: string): void {
    this.genericService.removeItemAssignment(bookmarkId);
  }

  // ========================================
  // Ordering
  // ========================================

  public reorderItems(folderId: string): void {
    this.genericService.reorderItems(folderId);
  }

  public moveItemToPosition(bookmarkId: string, newOrder: number): void {
    this.genericService.moveItemToPosition(bookmarkId, newOrder);
  }


  // ========================================
  // Root-level ordering (mixed folders + bookmarks)
  // ========================================

  public hasRootOrder(): boolean {
    return this.genericService.hasRootOrder();
  }

  public clearRootOrder(): void {
    this.genericService.clearRootOrder();
  }

  public clearAssignments(): void {
    this.genericService.clearAssignments();
  }

  public getRootOrder(): RootOrderItem<'bookmark'>[] {
    return this.genericService.getRootOrder();
  }

  public saveRootOrder(order: RootOrderItem<'bookmark'>[]): void {
    this.genericService.saveRootOrder(order);
  }

  public addToRootOrder(type: 'folder' | 'bookmark', id: string): void {
    this.genericService.addToRootOrder(type, id);
  }

  public removeFromRootOrder(type: 'folder' | 'bookmark', id: string): void {
    this.genericService.removeFromRootOrder(type, id);
  }

  public moveInRootOrder(type: 'folder' | 'bookmark', id: string, newIndex: number): void {
    this.genericService.moveInRootOrder(type, id, newIndex);
  }

  // ========================================
  // Cleanup
  // ========================================

  /**
   * Remove orphaned assignments (assignments referencing non-existent bookmarks)
   * Returns the number of removed orphans
   */
  public cleanupOrphanedAssignments(): number {
    return this.genericService.cleanupOrphanedAssignments();
  }

  // ========================================
  // Sync helpers (for future NIP-51 integration)
  // ========================================

  public exportFolderAsNip51(folderId: string): {
    dTag: string;
    titleTag: string;
    bookmarkIds: string[];
  } {
    const result = this.genericService.exportFolderAsNip51(folderId);
    return {
      dTag: result.dTag,
      titleTag: result.titleTag,
      bookmarkIds: result.itemIds
    };
  }
}
