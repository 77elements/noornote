/**
 * FolderAssignmentHelper
 * Helper function to create folders and assign items from relay categoryAssignments
 * Used by BookmarkManager and TribeManager during relay sync
 *
 * @purpose Reduce code duplication in afterRelaySync callbacks
 */

import { SystemLogger } from '../components/system/SystemLogger';

export interface FolderService {
  getFolders(): { id: string; name: string }[];
  createFolder(name: string): { id: string; name: string };
}

/**
 * Apply folder assignments from relay sync result
 * Creates folders for categories and assigns items to them
 *
 * @param categoryAssignments - Map of itemId → categoryName from relay
 * @param folderService - Service with getFolders() and createFolder()
 * @param moveToFolder - Function to move item to folder (itemId, folderId)
 * @param ensureAssignment - Function to ensure item has root assignment (itemId)
 * @param logCategory - Category name for SystemLogger (e.g., 'BookmarkManager', 'TribeManager')
 */
export async function applyFolderAssignments(
  categoryAssignments: Map<string, string>,
  folderService: FolderService,
  moveToFolder: (itemId: string, folderId: string) => void,
  ensureAssignment: (itemId: string) => void,
  logCategory: string
): Promise<void> {
  if (!categoryAssignments || categoryAssignments.size === 0) {
    return;
  }

  const systemLogger = SystemLogger.getInstance();
  const existingFolders = folderService.getFolders();

  // Collect categories that have items (skip empty string = root)
  const categoriesWithItems = new Set<string>();
  for (const [, categoryName] of categoryAssignments) {
    if (categoryName !== '') {
      categoriesWithItems.add(categoryName);
    }
  }

  // Create folders for new categories
  for (const categoryName of categoriesWithItems) {
    const existingFolder = existingFolders.find(f => f.name === categoryName);
    if (!existingFolder) {
      folderService.createFolder(categoryName);
      systemLogger.info(logCategory, `Created folder from relay: "${categoryName}"`);
    }
  }

  // Assign items to their categories
  const updatedFolders = folderService.getFolders();
  for (const [itemId, categoryName] of categoryAssignments) {
    if (categoryName === '') {
      // Root - ensure assignment exists
      ensureAssignment(itemId);
    } else {
      // Find folder by name and move item there
      const folder = updatedFolders.find(f => f.name === categoryName);
      if (folder) {
        moveToFolder(itemId, folder.id);
      }
    }
  }

  systemLogger.info(logCategory, `Restored ${categoriesWithItems.size} folders from relays`);
}
