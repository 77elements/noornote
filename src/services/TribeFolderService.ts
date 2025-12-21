/**
 * TribeFolderService
 * Manages tribe folders (categories) and member-to-folder assignments
 *
 * Storage Strategy:
 * - Uses PerAccountLocalStorage for per-account isolation
 * - Folders, assignments, and root order are all per-account
 *
 * NIP-51:
 * - Kind 30000 = Follow Sets (each tribe = one event)
 * - Tag order in event = member order in tribe
 *
 * @purpose Folder CRUD, member assignment, ordering
 * @used-by TribeSecondaryManager
 */

import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';

export interface TribeFolder {
  id: string;           // Unique identifier (will be d-tag in NIP-51)
  name: string;         // Display name (will be title-tag in NIP-51)
  createdAt: number;    // Timestamp
  order: number;        // Position in root view
}

export interface MemberAssignment {
  memberId: string;     // Pubkey
  folderId: string;     // Folder ID (empty string = root)
  order: number;        // Position within folder/root
}

export interface RootOrderItem {
  type: 'folder' | 'member';
  id: string;
}

export class TribeFolderService {
  private static instance: TribeFolderService;
  private storage: PerAccountLocalStorage;

  private constructor() {
    this.storage = PerAccountLocalStorage.getInstance();
  }

  public static getInstance(): TribeFolderService {
    if (!TribeFolderService.instance) {
      TribeFolderService.instance = new TribeFolderService();
    }
    return TribeFolderService.instance;
  }

  // ========================================
  // Folder CRUD
  // ========================================

  public getFolders(): TribeFolder[] {
    const folders = this.storage.get<TribeFolder[]>(StorageKeys.TRIBE_FOLDERS, []);
    return folders.sort((a, b) => a.order - b.order);
  }

  public getFolder(folderId: string): TribeFolder | null {
    const folders = this.getFolders();
    return folders.find(f => f.id === folderId) || null;
  }

  public createFolder(name: string): TribeFolder {
    const folders = this.getFolders();

    // Generate unique ID
    const id = `folder_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // Get max order for new folder
    const maxOrder = folders.reduce((max, f) => Math.max(max, f.order), -1);

    const folder: TribeFolder = {
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
    // Get all members in this folder before deletion
    const assignments = this.getAssignments();
    const affectedMemberIds = assignments
      .filter(a => a.folderId === folderId)
      .map(a => a.memberId);

    // Move all members from folder to root
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

    return affectedMemberIds;
  }

  private saveFolders(folders: TribeFolder[]): void {
    this.storage.set(StorageKeys.TRIBE_FOLDERS, folders);
  }

  // ========================================
  // Member-to-Folder Assignments
  // ========================================

  private getAssignments(): MemberAssignment[] {
    return this.storage.get<MemberAssignment[]>(StorageKeys.TRIBE_MEMBER_ASSIGNMENTS, []);
  }

  private saveAssignments(assignments: MemberAssignment[]): void {
    this.storage.set(StorageKeys.TRIBE_MEMBER_ASSIGNMENTS, assignments);
  }

  public getMemberFolder(memberId: string): string {
    const assignments = this.getAssignments();
    const assignment = assignments.find(a => a.memberId === memberId);
    return assignment?.folderId || '';
  }

  public getMembersInFolder(folderId: string): string[] {
    const assignments = this.getAssignments();
    return assignments
      .filter(a => a.folderId === folderId)
      .sort((a, b) => a.order - b.order)
      .map(a => a.memberId);
  }

  public getFolderItemCount(folderId: string): number {
    const assignments = this.getAssignments();
    return assignments.filter(a => a.folderId === folderId).length;
  }

  public moveMemberToFolder(memberId: string, targetFolderId: string, explicitOrder?: number): void {
    const assignments = this.getAssignments();
    const existing = assignments.find(a => a.memberId === memberId);

    if (existing) {
      const oldFolderId = existing.folderId;
      existing.folderId = targetFolderId;

      if (explicitOrder !== undefined) {
        existing.order = explicitOrder;
      } else {
        // Get max order in target folder
        const maxOrder = assignments
          .filter(a => a.folderId === targetFolderId && a.memberId !== memberId)
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
        memberId,
        folderId: targetFolderId,
        order
      });
      this.saveAssignments(assignments);
    }
  }

  public ensureMemberAssignment(memberId: string, explicitOrder?: number): void {
    const assignments = this.getAssignments();
    const existing = assignments.find(a => a.memberId === memberId);

    if (!existing) {
      // Add to root with specified order or next available
      const order = explicitOrder !== undefined
        ? explicitOrder
        : assignments
            .filter(a => a.folderId === '')
            .reduce((max, a) => Math.max(max, a.order), -1) + 1;

      assignments.push({
        memberId,
        folderId: '',
        order
      });
      this.saveAssignments(assignments);
    }
  }

  public removeMemberAssignment(memberId: string): void {
    const assignments = this.getAssignments().filter(a => a.memberId !== memberId);
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

  public moveItemToPosition(memberId: string, newOrder: number): void {
    const assignments = this.getAssignments();
    const item = assignments.find(a => a.memberId === memberId);
    if (!item) return;

    const folderId = item.folderId;
    const itemsInFolder = assignments
      .filter(a => a.folderId === folderId)
      .sort((a, b) => a.order - b.order);

    // Remove from current position
    const currentIndex = itemsInFolder.findIndex(a => a.memberId === memberId);
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
  // Root-level ordering (mixed folders + members)
  // ========================================

  public hasRootOrder(): boolean {
    const order = this.storage.get<RootOrderItem[]>(StorageKeys.TRIBE_ROOT_ORDER, []);
    return order.length > 0;
  }

  public clearRootOrder(): void {
    this.storage.remove(StorageKeys.TRIBE_ROOT_ORDER);
  }

  public clearAssignments(): void {
    this.storage.remove(StorageKeys.TRIBE_MEMBER_ASSIGNMENTS);
  }

  public getRootOrder(): RootOrderItem[] {
    const order = this.storage.get<RootOrderItem[]>(StorageKeys.TRIBE_ROOT_ORDER, []);
    if (order.length === 0) {
      // Build initial order from existing data
      return this.buildInitialRootOrder();
    }
    return order;
  }

  private buildInitialRootOrder(): RootOrderItem[] {
    const folders = this.getFolders();
    const rootMemberIds = this.getMembersInFolder('');

    const order: RootOrderItem[] = [];

    // Add members in reverse order (newest first) for initial display
    // User can reorder later via drag & drop
    const reversedMemberIds = [...rootMemberIds].reverse();
    reversedMemberIds.forEach(id => {
      order.push({ type: 'member', id });
    });

    // Add folders
    folders.forEach(f => {
      order.push({ type: 'folder', id: f.id });
    });

    this.saveRootOrder(order);
    return order;
  }

  public saveRootOrder(order: RootOrderItem[]): void {
    this.storage.set(StorageKeys.TRIBE_ROOT_ORDER, order);
  }

  public addToRootOrder(type: 'folder' | 'member', id: string): void {
    const order = this.getRootOrder();
    // Check if already exists
    if (!order.some(item => item.type === type && item.id === id)) {
      // Add at beginning (newest first)
      order.unshift({ type, id });
      this.saveRootOrder(order);
    }
  }

  public removeFromRootOrder(type: 'folder' | 'member', id: string): void {
    const order = this.getRootOrder().filter(
      item => !(item.type === type && item.id === id)
    );
    this.saveRootOrder(order);
  }

  public moveInRootOrder(type: 'folder' | 'member', id: string, newIndex: number): void {
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
   * Remove orphaned assignments (assignments referencing non-existent members)
   * Returns the number of removed orphans
   */
  public cleanupOrphanedAssignments(): number {
    // Get existing member IDs from storage
    const memberItems = this.storage.get<{ id: string }[]>(StorageKeys.TRIBES, []);
    const existingMemberIds = new Set(memberItems.map(item => item.id));

    // Get all assignments
    const assignments = this.getAssignments();
    const originalCount = assignments.length;

    // Filter to keep only assignments with existing members
    const cleanedAssignments = assignments.filter(a => existingMemberIds.has(a.memberId));

    const removedCount = originalCount - cleanedAssignments.length;

    if (removedCount > 0) {
      this.saveAssignments(cleanedAssignments);
    }

    return removedCount;
  }

  // ========================================
  // Sync helpers (for NIP-51 integration)
  // ========================================

  public exportFolderAsNip51(folderId: string): {
    dTag: string;
    titleTag: string;
    memberIds: string[];
  } {
    const folder = this.getFolder(folderId);
    if (!folder) throw new Error(`Folder not found: ${folderId}`);

    const memberIds = this.getMembersInFolder(folderId);

    return {
      dTag: folder.id,
      titleTag: folder.name,
      memberIds
    };
  }
}
