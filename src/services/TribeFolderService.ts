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
 * @pattern Wrapper around GenericFolderService
 */

import { GenericFolderService, type Folder, type RootOrderItem } from './GenericFolderService';
import { StorageKeys } from './PerAccountLocalStorage';

export interface TribeFolder extends Folder {}

export interface MemberAssignment {
  memberId: string;     // Pubkey
  folderId: string;     // Folder ID (empty string = root)
  order: number;        // Position within folder/root
}

export class TribeFolderService {
  private static instance: TribeFolderService;
  private genericService: GenericFolderService<'memberId', 'member'>;

  private constructor() {
    this.genericService = new GenericFolderService({
      folderStorageKey: StorageKeys.TRIBE_FOLDERS,
      assignmentStorageKey: StorageKeys.TRIBE_MEMBER_ASSIGNMENTS,
      rootOrderStorageKey: StorageKeys.TRIBE_ROOT_ORDER,
      itemsStorageKey: StorageKeys.TRIBES,
      itemType: 'member',
      itemIdField: 'memberId'
    });
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
    return this.genericService.getFolders();
  }

  public getFolder(folderId: string): TribeFolder | null {
    return this.genericService.getFolder(folderId);
  }

  public createFolder(name: string): TribeFolder {
    return this.genericService.createFolder(name);
  }

  public renameFolder(folderId: string, newName: string): void {
    this.genericService.renameFolder(folderId, newName);
  }

  public deleteFolder(folderId: string): string[] {
    // Tribes have NO root items - members are deleted together with the tribe
    const affectedMemberIds = this.getMembersInFolder(folderId);

    // Remove all assignments for this folder
    const allAssignments = this.genericService['getAssignments']();
    const updatedAssignments = allAssignments.filter(a => a.folderId !== folderId);
    this.genericService['saveAssignments'](updatedAssignments);

    // Delete folder
    const folders = this.getFolders().filter(f => f.id !== folderId);
    this.genericService['saveFolders'](folders);

    // Remove members from root order if they were there
    const rootOrder = this.getRootOrder();
    const updatedRootOrder = rootOrder.filter(item => {
      if (item.type === 'member') {
        return !affectedMemberIds.includes(item.id);
      }
      return item.id !== folderId;
    });
    this.saveRootOrder(updatedRootOrder);

    return affectedMemberIds;
  }

  // ========================================
  // Member-to-Folder Assignments
  // ========================================

  public getMemberFolder(memberId: string): string {
    return this.genericService.getItemFolder(memberId);
  }

  public getMembersInFolder(folderId: string): string[] {
    return this.genericService.getItemsInFolder(folderId);
  }

  public getFolderItemCount(folderId: string): number {
    return this.genericService.getFolderItemCount(folderId);
  }

  public moveMemberToFolder(memberId: string, targetFolderId: string, explicitOrder?: number): void {
    this.genericService.moveItemToFolder(memberId, targetFolderId, explicitOrder);
  }

  public ensureMemberAssignment(memberId: string, explicitOrder?: number): void {
    this.genericService.ensureItemAssignment(memberId, explicitOrder);
  }

  public removeMemberAssignment(memberId: string): void {
    this.genericService.removeItemAssignment(memberId);
  }

  // ========================================
  // Ordering
  // ========================================

  public reorderItems(folderId: string): void {
    this.genericService.reorderItems(folderId);
  }

  public moveItemToPosition(memberId: string, newOrder: number): void {
    this.genericService.moveItemToPosition(memberId, newOrder);
  }


  // ========================================
  // Root-level ordering (mixed folders + members)
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

  public getRootOrder(): RootOrderItem<'member'>[] {
    return this.genericService.getRootOrder();
  }

  public saveRootOrder(order: RootOrderItem<'member'>[]): void {
    this.genericService.saveRootOrder(order);
  }

  public addToRootOrder(type: 'folder' | 'member', id: string): void {
    this.genericService.addToRootOrder(type, id);
  }

  public removeFromRootOrder(type: 'folder' | 'member', id: string): void {
    this.genericService.removeFromRootOrder(type, id);
  }

  public moveInRootOrder(type: 'folder' | 'member', id: string, newIndex: number): void {
    this.genericService.moveInRootOrder(type, id, newIndex);
  }

  // ========================================
  // Cleanup
  // ========================================

  /**
   * Remove orphaned assignments (assignments referencing non-existent members)
   * Returns the number of removed orphans
   */
  public cleanupOrphanedAssignments(): number {
    return this.genericService.cleanupOrphanedAssignments();
  }

  // ========================================
  // Sync helpers (for NIP-51 integration)
  // ========================================

  public exportFolderAsNip51(folderId: string): {
    dTag: string;
    titleTag: string;
    memberIds: string[];
  } {
    const result = this.genericService.exportFolderAsNip51(folderId);
    return {
      dTag: result.dTag,
      titleTag: result.titleTag,
      memberIds: result.itemIds
    };
  }
}
