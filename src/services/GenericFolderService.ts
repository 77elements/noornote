/**
 * GenericFolderService
 * Generic folder management service for lists with folder organization
 *
 * Shared by:
 * - BookmarkFolderService (manages bookmark folders)
 * - TribeFolderService (manages tribe/member folders)
 *
 * @purpose Eliminate 424-line duplication between BookmarkFolderService and TribeFolderService
 * @pattern Template pattern with config-based initialization
 */

import { PerAccountLocalStorage } from './PerAccountLocalStorage';

// ========================================
// Generic Interfaces
// ========================================

export interface Folder {
  id: string;
  name: string;
  createdAt: number;
  order: number;
}

export interface Assignment<TItemId extends string> {
  [key: string]: string | number;  // Allow dynamic property names
  folderId: string;
  order: number;
}

export interface RootOrderItem<TItemType extends string> {
  type: 'folder' | TItemType;
  id: string;
}

// ========================================
// Configuration Interface
// ========================================

export interface FolderServiceConfig<TItemId extends string, TItemType extends string> {
  // Storage keys
  folderStorageKey: string;
  assignmentStorageKey: string;
  rootOrderStorageKey: string;
  itemsStorageKey: string;  // For cleanup (e.g., BOOKMARKS, TRIBE_MEMBERS)

  // Item type for RootOrderItem (e.g., 'bookmark', 'member')
  itemType: TItemType;

  // Assignment field name (e.g., 'bookmarkId', 'memberPubkey')
  itemIdField: TItemId;
}

// ========================================
// Generic Folder Service
// ========================================

export class GenericFolderService<TItemId extends string, TItemType extends string> {
  private storage: PerAccountLocalStorage;

  constructor(private config: FolderServiceConfig<TItemId, TItemType>) {
    this.storage = PerAccountLocalStorage.getInstance();
  }

  // ========================================
  // Folder CRUD
  // ========================================

  public getFolders(): Folder[] {
    const folders = this.storage.get<Folder[]>(this.config.folderStorageKey, []);
    return folders.sort((a, b) => a.order - b.order);
  }

  public getFolder(folderId: string): Folder | null {
    const folders = this.getFolders();
    return folders.find(f => f.id === folderId) || null;
  }

  public createFolder(name: string): Folder {
    const folders = this.getFolders();

    // Generate unique ID
    const id = `folder_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // Get max order for new folder
    const maxOrder = folders.reduce((max, f) => Math.max(max, f.order), -1);

    const folder: Folder = {
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
    // Get all items in this folder before deletion
    const assignments = this.getAssignments();
    const affectedItemIds = assignments
      .filter(a => a.folderId === folderId)
      .map(a => this.getItemIdFromAssignment(a));

    // Move all items from folder to root
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

    return affectedItemIds;
  }

  private saveFolders(folders: Folder[]): void {
    this.storage.set(this.config.folderStorageKey, folders);
  }

  // ========================================
  // Item-to-Folder Assignments
  // ========================================

  private getAssignments(): Assignment<TItemId>[] {
    return this.storage.get<Assignment<TItemId>[]>(this.config.assignmentStorageKey, []);
  }

  private saveAssignments(assignments: Assignment<TItemId>[]): void {
    this.storage.set(this.config.assignmentStorageKey, assignments);
  }

  private getItemIdFromAssignment(assignment: Assignment<TItemId>): string {
    return assignment[this.config.itemIdField] as string;
  }

  private createAssignment(itemId: string, folderId: string, order: number): Assignment<TItemId> {
    return {
      [this.config.itemIdField]: itemId,
      folderId,
      order
    } as Assignment<TItemId>;
  }

  public getItemFolder(itemId: string): string {
    const assignments = this.getAssignments();
    const assignment = assignments.find(a => this.getItemIdFromAssignment(a) === itemId);
    return assignment?.folderId || '';
  }

  public getItemsInFolder(folderId: string): string[] {
    const assignments = this.getAssignments();
    return assignments
      .filter(a => a.folderId === folderId)
      .sort((a, b) => a.order - b.order)
      .map(a => this.getItemIdFromAssignment(a));
  }

  public getFolderItemCount(folderId: string): number {
    const assignments = this.getAssignments();
    return assignments.filter(a => a.folderId === folderId).length;
  }

  public moveItemToFolder(itemId: string, targetFolderId: string, explicitOrder?: number): void {
    const assignments = this.getAssignments();
    const existing = assignments.find(a => this.getItemIdFromAssignment(a) === itemId);

    if (existing) {
      const oldFolderId = existing.folderId;
      existing.folderId = targetFolderId;

      if (explicitOrder !== undefined) {
        existing.order = explicitOrder;
      } else {
        // Get max order in target folder
        const maxOrder = assignments
          .filter(a => a.folderId === targetFolderId && this.getItemIdFromAssignment(a) !== itemId)
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

      assignments.push(this.createAssignment(itemId, targetFolderId, order));
      this.saveAssignments(assignments);
    }
  }

  public ensureItemAssignment(itemId: string, explicitOrder?: number): void {
    const assignments = this.getAssignments();
    const existing = assignments.find(a => this.getItemIdFromAssignment(a) === itemId);

    if (!existing) {
      // Add to root with specified order or next available
      const order = explicitOrder !== undefined
        ? explicitOrder
        : assignments
            .filter(a => a.folderId === '')
            .reduce((max, a) => Math.max(max, a.order), -1) + 1;

      assignments.push(this.createAssignment(itemId, '', order));
      this.saveAssignments(assignments);
    }
  }

  public removeItemAssignment(itemId: string): void {
    const assignments = this.getAssignments().filter(a => this.getItemIdFromAssignment(a) !== itemId);
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

  public moveItemToPosition(itemId: string, newOrder: number): void {
    const assignments = this.getAssignments();
    const item = assignments.find(a => this.getItemIdFromAssignment(a) === itemId);
    if (!item) return;

    const folderId = item.folderId;
    const itemsInFolder = assignments
      .filter(a => a.folderId === folderId)
      .sort((a, b) => a.order - b.order);

    // Remove from current position
    const currentIndex = itemsInFolder.findIndex(a => this.getItemIdFromAssignment(a) === itemId);
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
  // Root-level ordering (mixed folders + items)
  // ========================================

  public hasRootOrder(): boolean {
    const order = this.storage.get<RootOrderItem<TItemType>[]>(this.config.rootOrderStorageKey, []);
    return order.length > 0;
  }

  public clearRootOrder(): void {
    this.storage.remove(this.config.rootOrderStorageKey);
  }

  public clearAssignments(): void {
    this.storage.remove(this.config.assignmentStorageKey);
  }

  public getRootOrder(): RootOrderItem<TItemType>[] {
    const order = this.storage.get<RootOrderItem<TItemType>[]>(this.config.rootOrderStorageKey, []);
    if (order.length === 0) {
      // Build initial order from existing data
      return this.buildInitialRootOrder();
    }
    return order;
  }

  private buildInitialRootOrder(): RootOrderItem<TItemType>[] {
    const folders = this.getFolders();
    const rootItemIds = this.getItemsInFolder('');

    const order: RootOrderItem<TItemType>[] = [];

    // Add items in reverse order (newest first) for initial display
    // User can reorder later via drag & drop
    const reversedItemIds = [...rootItemIds].reverse();
    reversedItemIds.forEach(id => {
      order.push({ type: this.config.itemType, id });
    });

    // Add folders
    folders.forEach(f => {
      order.push({ type: 'folder', id: f.id });
    });

    this.saveRootOrder(order);
    return order;
  }

  public saveRootOrder(order: RootOrderItem<TItemType>[]): void {
    this.storage.set(this.config.rootOrderStorageKey, order);
  }

  public addToRootOrder(type: 'folder' | TItemType, id: string): void {
    const order = this.getRootOrder();
    // Check if already exists
    if (!order.some(item => item.type === type && item.id === id)) {
      // Add at beginning (newest first)
      order.unshift({ type, id });
      this.saveRootOrder(order);
    }
  }

  public removeFromRootOrder(type: 'folder' | TItemType, id: string): void {
    const order = this.getRootOrder().filter(
      item => !(item.type === type && item.id === id)
    );
    this.saveRootOrder(order);
  }

  public moveInRootOrder(type: 'folder' | TItemType, id: string, newIndex: number): void {
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
   * Remove orphaned assignments (assignments referencing non-existent items)
   * Returns the number of removed orphans
   */
  public cleanupOrphanedAssignments(): number {
    // Get existing item IDs from storage
    const items = this.storage.get<{ id: string }[]>(this.config.itemsStorageKey, []);
    const existingItemIds = new Set(items.map(item => item.id));

    // Get all assignments
    const assignments = this.getAssignments();
    const originalCount = assignments.length;

    // Filter to keep only assignments with existing items
    const cleanedAssignments = assignments.filter(a => existingItemIds.has(this.getItemIdFromAssignment(a)));

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
    itemIds: string[];
  } {
    const folder = this.getFolder(folderId);
    if (!folder) throw new Error(`Folder not found: ${folderId}`);

    const itemIds = this.getItemsInFolder(folderId);

    return {
      dTag: folder.id,
      titleTag: folder.name,
      itemIds
    };
  }
}
