/**
 * bookmarks.ts - Consolidated Bookmark List Management
 *
 * Contains ALL bookmark-related code:
 * - Types (BookmarkTag, BookmarkSet, BookmarkSetData, BookmarkItem)
 * - Browser storage (localStorage via PerAccountLocalStorage)
 * - File storage (~/.noornote/{npub}/bookmarks.json)
 * - Relay operations (NIP-51 kind:30003 Bookmark Sets)
 * - Serialization (NIP-51 format conversion)
 * - UI components (BookmarkManager, BookmarkCard, Modals)
 * - Storage adapter (for AutoSyncService)
 *
 * Folder assignment data is stored separately via GenericFolderService
 * Shared components (FolderCard, UpNavigator) are imported from /src/components/bookmarks/
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { SystemLogger } from '../services/SystemLogger';
import { TypedEventBus } from '../core/TypedEventBus';
import { AuthService } from '../services/AuthService';
import { ToastService } from '../services/ToastService';
import { ModalService } from '../services/ModalService';
import { NoteService } from '../services/NoteService';
import { DeletionService } from '../services/DeletionService';
import { UserProfileService } from '../services/UserProfileService';
import { Router } from '../services/Router';
import { ProfileMountsService } from '../services/ProfileMountsService';
import { ProfileMountsOrchestrator } from '../services/orchestration/ProfileMountsOrchestrator';
import {
  PerAccountLocalStorage,
  StorageKeys as PerAccountStorageKeys,
} from '../services/PerAccountLocalStorage';
import { PlatformService } from '../services/PlatformService';
import { diagLog } from '../services/DiagnosticLogger';

// Types for folder management (inlined from GenericFolderService)
export interface Folder {
  id: string;
  name: string;
}

export interface RootOrderItem<T extends string = string> {
  type: 'folder' | T;
  id: string;
}

import { encodeNevent } from '../services/NostrToolsAdapter';
import { formatBookmarkTimestamp } from '../helpers/formatTimestamp';
import { applyFolderAssignments } from '../helpers/FolderAssignmentHelper';
import {
  renderListSyncButtons,
  bindListSyncButtons,
  isEasyMode,
} from '../helpers/ListSyncMode';
import {
  SyncConfirmationModal,
  type MovedItemInfo,
} from '../components/modals/SyncConfirmationModal';
import { NewFolderModal } from '../components/modals/NewFolderModal';
import { EditFolderModal } from '../components/modals/EditFolderModal';
import {
  FolderCard,
  type FolderData,
} from '../components/bookmarks/FolderCard';
import { UpNavigator } from '../components/bookmarks/UpNavigator';
import { MoveDropdown } from '../components/ui/MoveDropdown';

// Shared helpers from /src/lists/
import {
  readList,
  writeList,
  StorageKeys,
  now,
  deduplicateById,
  mergeByKey,
} from './storage';
import { setupGridDragDrop } from '../helpers/gridDragDrop';
import {
  renderListHeader,
  renderListBreadcrumb,
  bindHeaderDropdown,
} from './list-header';
import {
  readJsonFile,
  writeJsonFile,
  uploadJsonFile,
  downloadAsJson,
} from './file';
import {
  fetchEvents,
  publishEvent,
  signEvent,
  requireAuth,
  getCurrentUserPubkey,
  getWriteRelays,
  encryptContent,
  decryptContent,
} from './relays';
import {
  type DeletionRecordConfig,
  publishDeletionChange,
  syncDeletionsIntoLocal,
} from './listDeletionRecord';

// Re-export for backward compatibility
export { StorageKeys };

const logger = SystemLogger.getInstance();

// =============================================================================
// SHARED UTILITIES
// =============================================================================

import { escapeHtml, escapeHtmlAttr } from '../helpers/escapeHtml';
import { ICON_TRASH_16 } from '../helpers/svgIcons';
import { getTag } from '../helpers/tagUtils';

/**
 * Validate URL format
 */
function isValidUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * Single bookmark tag within a set
 */
export interface BookmarkTag {
  type: 'e' | 'a' | 't' | 'r';
  value: string;
  description?: string;
}

/**
 * A bookmark set (maps to one kind:30003 event)
 */
export interface BookmarkSet {
  kind: 30003;
  d: string; // d-tag value ('' = root, 'Work' = Work folder, etc.)
  title: string;
  publicTags: BookmarkTag[];
  privateTags: BookmarkTag[]; // Stored encrypted in event content
}

/**
 * Complete bookmark data structure (stored in file)
 */
export interface BookmarkSetData {
  version: 2;
  sets: BookmarkSet[];
  metadata: {
    setOrder: string[]; // Order of d-tags (folders)
    lastModified: number;
  };
}

/**
 * Single bookmark item (for browser storage and UI)
 */
export interface BookmarkItem {
  id: string;
  type: 'e' | 'a' | 't' | 'r';
  value: string;
  addedAt?: number;
  isPrivate?: boolean;
  category?: string; // d-tag value (folder name)
  description?: string;
}

/**
 * Bookmark folder (extends generic Folder)
 */
export interface BookmarkFolder extends Folder {
  createdAt?: number;
}

/**
 * Folder assignment record
 */
export interface FolderAssignment {
  bookmarkId: string;
  folderId: string;
  order: number;
}

/**
 * Bookmark status (public/private)
 */
export interface BookmarkStatus {
  public: boolean;
  private: boolean;
}

/**
 * Bookmark with metadata
 */
export interface BookmarkWithMetadata {
  id: string;
  isPrivate: boolean;
  category?: string;
}

/**
 * Old bookmark file format (for migration)
 */
interface OldBookmarkFileData {
  items: BookmarkItem[];
  folders?: BookmarkFolder[];
  folderAssignments?: FolderAssignment[];
  rootOrder?: RootOrderItem<'bookmark'>[];
  lastModified: number;
}

/**
 * Result from fetching bookmarks from relays
 */
export interface FetchFromRelaysResult {
  items: BookmarkItem[];
  relayContentWasEmpty: boolean;
  categoryAssignments?: Map<string, string>;
  categories?: string[];
  relayTimestamp: number;
  /**
   * kind:5 deletion coordinates seen at fetch time. Map key = full
   * NIP-09 coordinate `30003:<pubkey>:<folderName>`, value = the latest
   * deletion's `created_at`. Surfaced for the AutoSyncService sanity-check
   * — applyOverwrite refuses to remove a folder silently unless we see
   * a corresponding deletion entry here. See docs/features/lists.md
   * "Mass-Deletion Incident + Schritt 1.5".
   */
  deletedCoordinates?: Map<string, number>;
}

// =============================================================================
// SERIALIZATION FUNCTIONS (from BookmarkSerializer.ts)
// =============================================================================

function createEmptySet(dTag: string): BookmarkSet {
  return { kind: 30003, d: dTag, title: dTag, publicTags: [], privateTags: [] };
}

function updateLastModified(data: BookmarkSetData): void {
  data.metadata.lastModified = now();
}

/**
 * Create empty bookmark set data
 */
export function createEmptyBookmarkSetData(): BookmarkSetData {
  return {
    version: 2,
    sets: [createEmptySet('')],
    metadata: { setOrder: [''], lastModified: now() },
  };
}

/**
 * Migrate from old file format to new BookmarkSetData format
 */
export function migrateFromOldFormat(
  oldData: OldBookmarkFileData
): BookmarkSetData {
  const folders = oldData.folders || [];
  const assignments = oldData.folderAssignments || [];
  const rootOrder = oldData.rootOrder || [];

  const rootSet = createEmptySet('');
  const folderSets = new Map(folders.map(f => [f.id, createEmptySet(f.name)]));
  const itemMap = new Map(oldData.items.map(item => [item.id, item]));

  const rootAssignments: FolderAssignment[] = [];
  const folderAssignmentsMap = new Map<string, FolderAssignment[]>();

  for (const assignment of assignments) {
    if (assignment.folderId && folderSets.has(assignment.folderId)) {
      const existing = folderAssignmentsMap.get(assignment.folderId) || [];
      existing.push(assignment);
      folderAssignmentsMap.set(assignment.folderId, existing);
    } else {
      rootAssignments.push(assignment);
    }
  }

  const assignedIds = new Set(assignments.map(a => a.bookmarkId));
  for (const item of oldData.items) {
    if (!assignedIds.has(item.id)) {
      rootAssignments.push({
        bookmarkId: item.id,
        folderId: '',
        order: rootAssignments.length,
      });
    }
  }

  const addItemToSet = (set: BookmarkSet, item: BookmarkItem): void => {
    const tag: BookmarkTag = {
      type: item.type,
      value: item.value,
      ...(item.description !== undefined && { description: item.description }),
    };
    (item.isPrivate ? set.privateTags : set.publicTags).push(tag);
  };

  const processAssignments = (
    targetSet: BookmarkSet,
    assignmentList: FolderAssignment[]
  ): void => {
    assignmentList.sort((a, b) => a.order - b.order);
    for (const assignment of assignmentList) {
      const item = itemMap.get(assignment.bookmarkId);
      if (item) addItemToSet(targetSet, item);
    }
  };

  processAssignments(rootSet, rootAssignments);
  for (const [folderId, folderAssignments] of folderAssignmentsMap) {
    processAssignments(folderSets.get(folderId)!, folderAssignments);
  }

  // Build setOrder from rootOrder, then add any missing folders
  const setOrder: string[] = [''];
  for (const item of rootOrder) {
    if (item.type === 'folder') {
      const folder = folders.find(f => f.id === item.id);
      if (folder) setOrder.push(folder.name);
    }
  }
  for (const folder of folders) {
    if (!setOrder.includes(folder.name)) {
      setOrder.push(folder.name);
    }
  }

  return {
    version: 2,
    sets: [rootSet, ...folderSets.values()],
    metadata: { setOrder, lastModified: oldData.lastModified },
  };
}

/**
 * Check if data is old format
 */
export function isOldFormat(data: unknown): data is OldBookmarkFileData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return Array.isArray(obj.items) && obj.version !== 2;
}

/**
 * Check if data is new format
 */
export function isNewFormat(data: unknown): data is BookmarkSetData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return obj.version === 2 && Array.isArray(obj.sets);
}

/**
 * Get all bookmark values from set data
 */
export function getAllBookmarkValues(data: BookmarkSetData): string[] {
  const values = new Set<string>();
  for (const set of data.sets) {
    for (const tag of [...set.publicTags, ...set.privateTags]) {
      values.add(tag.value);
    }
  }
  return Array.from(values);
}

/**
 * Check if a value is bookmarked
 */
export function isValueBookmarked(
  data: BookmarkSetData,
  value: string
): { exists: boolean; isPrivate: boolean; dTag: string } {
  for (const set of data.sets) {
    if (set.publicTags.some(t => t.value === value)) {
      return { exists: true, isPrivate: false, dTag: set.d };
    }
    if (set.privateTags.some(t => t.value === value)) {
      return { exists: true, isPrivate: true, dTag: set.d };
    }
  }
  return { exists: false, isPrivate: false, dTag: '' };
}

/**
 * Add bookmark to set data
 */
export function addBookmarkToSetData(
  data: BookmarkSetData,
  dTag: string,
  tag: BookmarkTag,
  isPrivate: boolean
): void {
  let set = data.sets.find(s => s.d === dTag);
  if (!set) {
    set = createEmptySet(dTag);
    data.sets.push(set);
    data.metadata.setOrder.push(dTag);
  }

  const targetArray = isPrivate ? set.privateTags : set.publicTags;
  if (!targetArray.some(t => t.type === tag.type && t.value === tag.value)) {
    targetArray.push(tag);
    updateLastModified(data);
  }
}

/**
 * Remove bookmark from set data
 */
export function removeBookmarkFromSetData(
  data: BookmarkSetData,
  value: string
): void {
  for (const set of data.sets) {
    set.publicTags = set.publicTags.filter(t => t.value !== value);
    set.privateTags = set.privateTags.filter(t => t.value !== value);
  }
  updateLastModified(data);
}

/**
 * Move bookmark between sets
 */
export function moveBookmarkInSetData(
  data: BookmarkSetData,
  value: string,
  targetDTag: string
): void {
  let foundTag: BookmarkTag | undefined;
  let wasPrivate = false;

  for (const set of data.sets) {
    const pubIdx = set.publicTags.findIndex(t => t.value === value);
    if (pubIdx !== -1) {
      foundTag = set.publicTags[pubIdx];
      set.publicTags.splice(pubIdx, 1);
      break;
    }
    const privIdx = set.privateTags.findIndex(t => t.value === value);
    if (privIdx !== -1) {
      foundTag = set.privateTags[privIdx];
      wasPrivate = true;
      set.privateTags.splice(privIdx, 1);
      break;
    }
  }

  if (foundTag) {
    addBookmarkToSetData(data, targetDTag, foundTag, wasPrivate);
  }
}

/**
 * Create new set (folder)
 */
export function createSetInData(data: BookmarkSetData, name: string): void {
  if (data.sets.some(s => s.d === name)) return;

  data.sets.push(createEmptySet(name));
  data.metadata.setOrder.push(name);
  updateLastModified(data);
}

/**
 * Delete set (folder) - moves items to root
 */
export function deleteSetFromData(data: BookmarkSetData, dTag: string): void {
  if (dTag === '') return;

  const set = data.sets.find(s => s.d === dTag);
  if (!set) return;

  const rootSet = data.sets.find(s => s.d === '');
  if (!rootSet) return;
  rootSet.publicTags.push(...set.publicTags);
  rootSet.privateTags.push(...set.privateTags);

  data.sets = data.sets.filter(s => s.d !== dTag);
  data.metadata.setOrder = data.metadata.setOrder.filter(d => d !== dTag);
  updateLastModified(data);
}

const VALID_TAG_TYPES = new Set(['e', 'a', 't', 'r']);

/**
 * Convert tags to items (for relay fetch)
 */
function tagsToItems(tags: string[][], timestamp: number): BookmarkItem[] {
  diagLog('lists', 'tagsToItems: input tag count', { count: tags.length });
  const items: BookmarkItem[] = [];
  for (const tag of tags) {
    const [tagType, tagValue, description] = tag;
    if (!tagType || !tagValue || !VALID_TAG_TYPES.has(tagType)) continue;
    const item: BookmarkItem = {
      id: tagValue,
      type: tagType as 'e' | 'a' | 't' | 'r',
      value: tagValue,
      addedAt: timestamp,
    };
    if (description) item.description = description;
    items.push(item);
  }
  diagLog('lists', 'tagsToItems: output', {
    count: items.length,
    items: items.map(i => ({ id: i.id, type: i.type })),
  });
  return items;
}

// =============================================================================
// BROWSER STORAGE (localStorage)
// =============================================================================

/**
 * Read bookmarks from browser localStorage
 */
export function readBrowserBookmarks(): BookmarkItem[] {
  const items = readList<BookmarkItem>(StorageKeys.BOOKMARKS, []);
  diagLog('lists', 'readBrowserBookmarks', {
    count: items.length,
    ids: items.map(i => i.id),
  });
  return items;
}

/**
 * Write bookmarks to browser localStorage
 */
export function writeBrowserBookmarks(items: BookmarkItem[]): void {
  diagLog('lists', 'writeBrowserBookmarks', {
    count: items.length,
    ids: items.map(i => i.id),
  });
  writeList(StorageKeys.BOOKMARKS, items);
  TypedEventBus.getInstance().emit('bookmark:updated');
}

/**
 * Add bookmark to browser storage
 */
export function addToBrowserBookmarks(item: BookmarkItem): void {
  const items = readBrowserBookmarks();
  if (items.some(b => b.id === item.id)) return;
  items.push(item);
  writeBrowserBookmarks(items);
}

/**
 * Remove bookmark from browser storage
 */
export function removeFromBrowserBookmarks(id: string): void {
  const items = readBrowserBookmarks();
  writeBrowserBookmarks(items.filter(b => b.id !== id));
}

// =============================================================================
// FILE STORAGE (Desktop)
// =============================================================================

const BOOKMARK_FILE = 'bookmarks.json';

/**
 * Read bookmark set data from file
 */
export async function readBookmarkFile(): Promise<BookmarkSetData> {
  const data = await readJsonFile<unknown>(BOOKMARK_FILE, null);

  if (!data) {
    return createEmptyBookmarkSetData();
  }

  // Handle old format migration
  if (isOldFormat(data)) {
    logger.info('bookmarks.ts', 'Migrating from old bookmark file format');
    const migrated = migrateFromOldFormat(data);
    await writeBookmarkFile(migrated);
    return migrated;
  }

  if (isNewFormat(data)) {
    return data;
  }

  logger.warn('bookmarks.ts', 'Unknown bookmark file format, using defaults');
  return createEmptyBookmarkSetData();
}

/**
 * Write bookmark set data to file
 */
export async function writeBookmarkFile(data: BookmarkSetData): Promise<void> {
  data.metadata.lastModified = now();
  await writeJsonFile(BOOKMARK_FILE, data);
}

/**
 * Convert tag to BookmarkItem
 */
function tagToItem(
  tag: BookmarkTag,
  isPrivate: boolean,
  category: string
): BookmarkItem {
  return {
    id: tag.value,
    type: tag.type,
    value: tag.value,
    isPrivate,
    category,
    ...(tag.description !== undefined && { description: tag.description }),
  };
}

/**
 * Extract all bookmarks from set data as items
 */
export function extractItemsFromSetData(data: BookmarkSetData): BookmarkItem[] {
  return data.sets.flatMap(set => [
    ...set.publicTags.map(tag => tagToItem(tag, false, set.d)),
    ...set.privateTags.map(tag => tagToItem(tag, true, set.d)),
  ]);
}

/**
 * Extract folder data from set data for FolderService restoration
 */
export function extractFolderDataFromSetData(data: BookmarkSetData): {
  folders: BookmarkFolder[];
  folderAssignments: FolderAssignment[];
  rootOrder: RootOrderItem<'bookmark'>[];
} {
  const folders: BookmarkFolder[] = [];
  const folderAssignments: FolderAssignment[] = [];
  const rootOrder: RootOrderItem<'bookmark'>[] = [];

  // Process non-root sets (folders)
  for (const set of data.sets) {
    if (set.d === '') continue;

    const folderId = `folder_${set.d}`;
    folders.push({
      id: folderId,
      name: set.d,
      createdAt: data.metadata.lastModified,
    });
    rootOrder.push({ type: 'folder', id: folderId });

    const allTags = [...set.publicTags, ...set.privateTags];
    allTags.forEach((tag, order) => {
      folderAssignments.push({ bookmarkId: tag.value, folderId, order });
    });
  }

  // Process root set items
  const rootSet = data.sets.find(s => s.d === '');
  if (rootSet) {
    const allTags = [...rootSet.publicTags, ...rootSet.privateTags];
    allTags.forEach((tag, order) => {
      folderAssignments.push({ bookmarkId: tag.value, folderId: '', order });
      rootOrder.push({ type: 'bookmark', id: tag.value });
    });
  }

  return { folders, folderAssignments, rootOrder };
}

/**
 * Get all bookmarks from file (for BookmarkStorageAdapter)
 */
export async function getAllBookmarksFromFile(): Promise<BookmarkItem[]> {
  const data = await readBookmarkFile();
  return extractItemsFromSetData(data);
}

/**
 * Get all folder data from file (for restoration)
 */
export async function getAllFolderDataFromFile(): Promise<{
  folders: BookmarkFolder[];
  folderAssignments: FolderAssignment[];
  rootOrder: RootOrderItem<'bookmark'>[];
}> {
  const data = await readBookmarkFile();
  return extractFolderDataFromSetData(data);
}

// =============================================================================
// BOOKMARK FOLDER SERVICE (self-contained, no external dependencies)
// =============================================================================

/**
 * Assignment record for bookmark-to-folder mapping
 */
interface BookmarkAssignment {
  bookmarkId: string;
  folderId: string;
  order: number;
}

/**
 * Bookmark folder service singleton
 * Manages folders, assignments, and root ordering using PerAccountLocalStorage
 */
class BookmarkFolderServiceImpl {
  private static instance: BookmarkFolderServiceImpl;
  private storage: PerAccountLocalStorage;

  private constructor() {
    this.storage = PerAccountLocalStorage.getInstance();
  }

  public static getInstance(): BookmarkFolderServiceImpl {
    if (!BookmarkFolderServiceImpl.instance) {
      BookmarkFolderServiceImpl.instance = new BookmarkFolderServiceImpl();
    }
    return BookmarkFolderServiceImpl.instance;
  }

  // ===== Storage Helpers =====

  private getFoldersFromStorage(): BookmarkFolder[] {
    return this.storage.get<BookmarkFolder[]>(
      PerAccountStorageKeys.BOOKMARK_FOLDERS,
      []
    );
  }

  private saveFoldersToStorage(folders: BookmarkFolder[]): void {
    this.storage.set(PerAccountStorageKeys.BOOKMARK_FOLDERS, folders);
  }

  private getAssignmentsFromStorage(): BookmarkAssignment[] {
    return this.storage.get<BookmarkAssignment[]>(
      PerAccountStorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS,
      []
    );
  }

  private saveAssignmentsToStorage(assignments: BookmarkAssignment[]): void {
    this.storage.set(
      PerAccountStorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS,
      assignments
    );
  }

  private getRootOrderFromStorage(): RootOrderItem<'bookmark'>[] {
    return this.storage.get<RootOrderItem<'bookmark'>[]>(
      PerAccountStorageKeys.BOOKMARK_ROOT_ORDER,
      []
    );
  }

  private saveRootOrderToStorage(order: RootOrderItem<'bookmark'>[]): void {
    this.storage.set(PerAccountStorageKeys.BOOKMARK_ROOT_ORDER, order);
  }

  // ===== Folder CRUD =====

  public getFolders(): BookmarkFolder[] {
    const folders = this.getFoldersFromStorage();
    diagLog('lists', 'getFolders', {
      folders: folders.map(f => ({ id: f.id, name: f.name })),
    });
    return folders;
  }

  public getFolder(folderId: string): BookmarkFolder | null {
    const folders = this.getFoldersFromStorage();
    return folders.find(f => f.id === folderId) || null;
  }

  public createFolder(name: string): BookmarkFolder {
    // Clear any prior tombstone for this folder name — explicit user re-creation
    // re-instates the folder and must override past delete intent.
    removeBookmarkFolderTombstone(name);

    const folders = this.getFoldersFromStorage();
    const newFolder: BookmarkFolder = {
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
    };
    folders.push(newFolder);
    this.saveFoldersToStorage(folders);
    this.addToRootOrder('folder', newFolder.id);
    return newFolder;
  }

  public renameFolder(folderId: string, newName: string): void {
    const folders = this.getFoldersFromStorage();
    const folder = folders.find(f => f.id === folderId);
    if (folder) {
      folder.name = newName;
      this.saveFoldersToStorage(folders);
    }
  }

  public deleteFolder(folderId: string): string[] {
    // Get items in this folder before deleting
    const itemsInFolder = this.getBookmarksInFolder(folderId);

    // Remove folder
    const folders = this.getFoldersFromStorage();
    const filtered = folders.filter(f => f.id !== folderId);
    this.saveFoldersToStorage(filtered);

    // Remove all assignments for this folder
    const assignments = this.getAssignmentsFromStorage();
    const filteredAssignments = assignments.filter(
      a => a.folderId !== folderId
    );
    this.saveAssignmentsToStorage(filteredAssignments);

    // Remove from root order
    this.removeFromRootOrder('folder', folderId);

    return itemsInFolder;
  }

  // ===== Bookmark-to-Folder Assignments =====

  public getBookmarkFolder(bookmarkId: string): string {
    const assignments = this.getAssignmentsFromStorage();
    const assignment = assignments.find(a => a.bookmarkId === bookmarkId);
    return assignment?.folderId || '';
  }

  public getBookmarksInFolder(folderId: string): string[] {
    const assignments = this.getAssignmentsFromStorage();
    const result = assignments
      .filter(a => a.folderId === folderId)
      .sort((a, b) => a.order - b.order)
      .map(a => a.bookmarkId);
    diagLog('lists', 'getBookmarksInFolder', { folderId, result });
    return result;
  }

  public getFolderItemCount(folderId: string): number {
    const assignments = this.getAssignmentsFromStorage();
    return assignments.filter(a => a.folderId === folderId).length;
  }

  public moveBookmarkToFolder(
    bookmarkId: string,
    targetFolderId: string,
    explicitOrder?: number
  ): void {
    diagLog('lists', 'moveBookmarkToFolder', {
      bookmarkId,
      targetFolderId,
      explicitOrder,
    });
    const assignments = this.getAssignmentsFromStorage();

    // Remove existing assignment
    const filtered = assignments.filter(a => a.bookmarkId !== bookmarkId);

    if (targetFolderId) {
      // Calculate order
      const folderItems = filtered.filter(a => a.folderId === targetFolderId);
      const order =
        explicitOrder ??
        (folderItems.length > 0
          ? Math.max(...folderItems.map(a => a.order)) + 1
          : 0);

      filtered.push({ bookmarkId, folderId: targetFolderId, order });
    }

    this.saveAssignmentsToStorage(filtered);
  }

  public ensureBookmarkAssignment(
    bookmarkId: string,
    _explicitOrder?: number
  ): void {
    const assignments = this.getAssignmentsFromStorage();
    const existing = assignments.find(a => a.bookmarkId === bookmarkId);
    diagLog('lists', 'ensureBookmarkAssignment', {
      bookmarkId,
      existing: !!existing,
    });

    if (!existing) {
      // Add to root (no folder)
      this.addToRootOrder('bookmark', bookmarkId);
    }
  }

  public removeBookmarkAssignment(bookmarkId: string): void {
    const assignments = this.getAssignmentsFromStorage();
    const filtered = assignments.filter(a => a.bookmarkId !== bookmarkId);
    this.saveAssignmentsToStorage(filtered);
    this.removeFromRootOrder('bookmark', bookmarkId);
  }

  // ===== Ordering =====

  public reorderItems(folderId: string): void {
    const assignments = this.getAssignmentsFromStorage();
    const folderItems = assignments
      .filter(a => a.folderId === folderId)
      .sort((a, b) => a.order - b.order);

    folderItems.forEach((item, index) => {
      item.order = index;
    });

    this.saveAssignmentsToStorage(assignments);
  }

  public moveItemToPosition(bookmarkId: string, newOrder: number): void {
    const assignments = this.getAssignmentsFromStorage();
    const assignment = assignments.find(a => a.bookmarkId === bookmarkId);
    if (assignment) {
      assignment.order = newOrder;
      this.saveAssignmentsToStorage(assignments);
    }
  }

  // ===== Root-level ordering =====

  public hasRootOrder(): boolean {
    const order = this.getRootOrderFromStorage();
    return order.length > 0;
  }

  public clearRootOrder(): void {
    this.saveRootOrderToStorage([]);
  }

  public clearAssignments(): void {
    this.saveAssignmentsToStorage([]);
  }

  public getRootOrder(): RootOrderItem<'bookmark'>[] {
    return this.getRootOrderFromStorage();
  }

  public saveRootOrder(order: RootOrderItem<'bookmark'>[]): void {
    this.saveRootOrderToStorage(order);
  }

  public addToRootOrder(type: 'folder' | 'bookmark', id: string): void {
    const order = this.getRootOrderFromStorage();
    if (!order.some(item => item.type === type && item.id === id)) {
      order.push({ type, id });
      this.saveRootOrderToStorage(order);
    }
  }

  public removeFromRootOrder(type: 'folder' | 'bookmark', id: string): void {
    const order = this.getRootOrderFromStorage();
    const filtered = order.filter(
      item => !(item.type === type && item.id === id)
    );
    this.saveRootOrderToStorage(filtered);
  }

  public moveInRootOrder(
    type: 'folder' | 'bookmark',
    id: string,
    newIndex: number
  ): void {
    const order = this.getRootOrderFromStorage();
    const currentIndex = order.findIndex(
      item => item.type === type && item.id === id
    );

    if (currentIndex !== -1) {
      const item = order[currentIndex]!;
      order.splice(currentIndex, 1);
      order.splice(newIndex, 0, item);
      this.saveRootOrderToStorage(order);
    }
  }

  // ===== Cleanup =====

  public cleanupOrphanedAssignments(): number {
    const assignments = this.getAssignmentsFromStorage();
    const folders = this.getFoldersFromStorage();
    const folderIds = new Set(folders.map(f => f.id));

    const validAssignments = assignments.filter(
      a => a.folderId === '' || folderIds.has(a.folderId)
    );
    const removedCount = assignments.length - validAssignments.length;
    diagLog('lists', 'cleanupOrphanedAssignments', {
      total: assignments.length,
      valid: validAssignments.length,
      removed: removedCount,
    });

    if (removedCount > 0) {
      this.saveAssignmentsToStorage(validAssignments);
    }

    return removedCount;
  }

  // ===== Export for NIP-51 =====

  public exportFolderAsNip51(folderId: string): {
    dTag: string;
    titleTag: string;
    bookmarkIds: string[];
  } {
    const folder = this.getFolder(folderId);
    const bookmarkIds = this.getBookmarksInFolder(folderId);

    return {
      dTag: folder?.name || folderId,
      titleTag: folder?.name || 'Unnamed Folder',
      bookmarkIds,
    };
  }

  // ===== Full Restore =====

  public restoreAllFolderData(
    folders: BookmarkFolder[],
    assignments: FolderAssignment[],
    rootOrder: RootOrderItem<'bookmark'>[]
  ): void {
    diagLog('lists', 'restoreAllFolderData', {
      folders: folders.map(f => ({ id: f.id, name: f.name })),
      assignmentCount: assignments.length,
      rootOrder,
    });
    this.saveFoldersToStorage(folders);
    this.saveAssignmentsToStorage(
      assignments.map(a => ({
        bookmarkId: a.bookmarkId,
        folderId: a.folderId,
        order: a.order,
      }))
    );
    this.saveRootOrderToStorage(rootOrder);
  }
}

/**
 * Get bookmark folder service instance
 */
export function getBookmarkFolderService(): BookmarkFolderServiceImpl {
  return BookmarkFolderServiceImpl.getInstance();
}

/**
 * Apply only the folder order from relay categories to browser RootOrder.
 * Does NOT touch items, folders, or assignments — only reorders existing folders.
 */
export function applyRelayFolderOrder(categories: string[]): void {
  const folderService = getBookmarkFolderService();
  const existingFolders = folderService.getFolders();
  const currentRootOrder = folderService.getRootOrder();

  const folderNameToId = new Map<string, string>();
  for (const f of existingFolders) {
    folderNameToId.set(f.name, f.id);
  }

  // Build new order: relay folder order first, then remaining items as-is
  const newRootOrder: RootOrderItem<'bookmark'>[] = [];
  const usedIds = new Set<string>();

  // Add folders in relay order
  for (const cat of categories) {
    if (!cat) continue;
    const folderId = folderNameToId.get(cat);
    if (folderId) {
      newRootOrder.push({ type: 'folder', id: folderId });
      usedIds.add(folderId);
    }
  }

  // Keep all non-folder items and any folders not in relay in their existing order
  for (const item of currentRootOrder) {
    if (!usedIds.has(item.id)) {
      newRootOrder.push(item);
    }
  }

  diagLog('lists', 'applyRelayFolderOrder', { categories, newRootOrder });
  folderService.saveRootOrder(newRootOrder);
}

/**
 * Apply relay fetch result to browser storage
 * Creates folders and assignments based on bookmark categories
 */
export function applyRelayFetchResult(
  items: BookmarkItem[],
  _categoryAssignments: Map<string, string> | undefined,
  categories: string[] | undefined
): void {
  diagLog('lists', 'applyRelayFetchResult: input', {
    itemCount: items.length,
    categories,
  });
  // Build folders from categories (skip empty/root category)
  const newFolders: BookmarkFolder[] = [];
  const folderNameToId = new Map<string, string>();
  const skippedTombstoned: string[] = [];

  if (categories) {
    for (const dTag of categories) {
      // Skip root category (empty or generic "bookmarks")
      if (!dTag || dTag === '' || dTag === 'bookmarks') continue;

      // Defense in depth: even if a tombstoned folder leaked past the fetch
      // filter, never re-create it in the local state here.
      if (isBookmarkFolderTombstoned(dTag)) {
        skippedTombstoned.push(dTag);
        continue;
      }

      // Use category name as folder name
      const folderName = dTag;
      const folderId = `folder_${folderName}`;
      newFolders.push({
        id: folderId,
        name: folderName,
        createdAt: Date.now(),
      });
      folderNameToId.set(folderName, folderId);
    }
  }

  if (skippedTombstoned.length > 0) {
    diagLog(
      'lists',
      'applyRelayFetchResult: suppressed tombstoned categories',
      { skipped: skippedTombstoned }
    );
  }

  // Build assignments from item categories
  const newAssignments: BookmarkAssignment[] = [];
  const newRootOrder: RootOrderItem<'bookmark'>[] = [];

  // Add folders to root order first
  for (const folder of newFolders) {
    newRootOrder.push({ type: 'folder', id: folder.id });
  }

  // Assign items to their folders
  for (const item of items) {
    const categoryName = item.category || '';
    const folderId = folderNameToId.get(categoryName);

    if (folderId) {
      // Item belongs to a folder
      newAssignments.push({
        bookmarkId: item.id,
        folderId,
        order: newAssignments.filter(a => a.folderId === folderId).length,
      });
    } else {
      // Item is in root
      newRootOrder.push({ type: 'bookmark', id: item.id });
    }
  }

  diagLog('lists', 'applyRelayFetchResult: output', {
    newFolders: newFolders.map(f => ({ id: f.id, name: f.name })),
    newAssignmentCount: newAssignments.length,
    newRootOrder,
  });

  // Apply folder structure only (NOT items - that's done by applySyncFromRelays)
  const storage = PerAccountLocalStorage.getInstance();
  storage.set(PerAccountStorageKeys.BOOKMARK_FOLDERS, newFolders);
  storage.set(
    PerAccountStorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS,
    newAssignments
  );
  storage.set(PerAccountStorageKeys.BOOKMARK_ROOT_ORDER, newRootOrder);

  SystemLogger.getInstance().info(
    'bookmarks.ts',
    `Applied folder structure: ${newFolders.length} folders`
  );
}

/**
 * Add folder assignments for NEW bookmarks only (onKeep / auto-merge).
 * Does NOT touch existing browser folder structure — only adds assignments for newly added items.
 */
export function addNewBookmarksToFolders(newItems: BookmarkItem[]): void {
  diagLog('lists', 'addNewBookmarksToFolders: input', {
    items: newItems.map(i => ({ id: i.id, category: i.category })),
  });
  if (newItems.length === 0) return;

  const storage = PerAccountLocalStorage.getInstance();
  const existingFolders = storage.get<BookmarkFolder[]>(
    PerAccountStorageKeys.BOOKMARK_FOLDERS,
    []
  );
  const existingAssignments = storage.get<BookmarkAssignment[]>(
    PerAccountStorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS,
    []
  );
  const existingRootOrder = storage.get<RootOrderItem<'bookmark'>[]>(
    PerAccountStorageKeys.BOOKMARK_ROOT_ORDER,
    []
  );
  diagLog('lists', 'addNewBookmarksToFolders: existing state', {
    folders: existingFolders.map(f => ({ id: f.id, name: f.name })),
    assignmentCount: existingAssignments.length,
    rootOrder: existingRootOrder,
  });

  const folderNameToId = new Map<string, string>();
  for (const f of existingFolders) {
    folderNameToId.set(f.name, f.id);
  }

  const addedFolders: BookmarkFolder[] = [];
  const addedAssignments: BookmarkAssignment[] = [];
  const addedRootOrderItems: RootOrderItem<'bookmark'>[] = [];

  for (const item of newItems) {
    const categoryName = item.category || '';
    if (!categoryName) {
      // Root item — add to root order if not already there
      const alreadyInRoot = existingRootOrder.some(
        r => r.type === 'bookmark' && r.id === item.id
      );
      if (!alreadyInRoot) {
        addedRootOrderItems.push({ type: 'bookmark', id: item.id });
      }
      continue;
    }

    // Defense in depth: if the item's category was tombstoned on this device,
    // drop the item into root rather than re-creating the dead folder.
    if (isBookmarkFolderTombstoned(categoryName)) {
      const alreadyInRoot = existingRootOrder.some(
        r => r.type === 'bookmark' && r.id === item.id
      );
      if (!alreadyInRoot) {
        addedRootOrderItems.push({ type: 'bookmark', id: item.id });
      }
      continue;
    }

    // Create folder if it doesn't exist yet
    let folderId = folderNameToId.get(categoryName);
    if (!folderId) {
      folderId = `folder_${categoryName}`;
      addedFolders.push({
        id: folderId,
        name: categoryName,
        createdAt: Date.now(),
      });
      addedRootOrderItems.push({ type: 'folder', id: folderId });
      folderNameToId.set(categoryName, folderId);
    }

    // Add assignment if not already assigned
    const alreadyAssigned = existingAssignments.some(
      a => a.bookmarkId === item.id
    );
    if (!alreadyAssigned) {
      const orderInFolder = [
        ...existingAssignments,
        ...addedAssignments,
      ].filter(a => a.folderId === folderId).length;
      addedAssignments.push({
        bookmarkId: item.id,
        folderId: folderId!,
        order: orderInFolder,
      });
    }
  }

  diagLog('lists', 'addNewBookmarksToFolders: adding', {
    folders: addedFolders.map(f => ({ id: f.id, name: f.name })),
    assignments: addedAssignments,
    rootOrderItems: addedRootOrderItems,
  });

  if (addedFolders.length > 0) {
    storage.set(PerAccountStorageKeys.BOOKMARK_FOLDERS, [
      ...existingFolders,
      ...addedFolders,
    ]);
  }
  if (addedAssignments.length > 0) {
    storage.set(PerAccountStorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS, [
      ...existingAssignments,
      ...addedAssignments,
    ]);
  }
  if (addedRootOrderItems.length > 0) {
    storage.set(PerAccountStorageKeys.BOOKMARK_ROOT_ORDER, [
      ...existingRootOrder,
      ...addedRootOrderItems,
    ]);
  }

  SystemLogger.getInstance().info(
    'bookmarks.ts',
    `Added folder assignments for ${addedAssignments.length} new bookmarks, ${addedFolders.length} new folders`
  );
}

/**
 * Merge relay folder structure while preserving browser-only bookmarks' assignments (onMerge).
 * Applies relay folder structure as base, then re-adds any browser-only items that would be lost.
 */
export function mergeRelayBookmarkStructurePreservingBrowserOnly(
  relayItems: BookmarkItem[],
  categories: string[] | undefined,
  browserOnlyItems: BookmarkItem[]
): void {
  diagLog(
    'lists',
    'mergeRelayBookmarkStructurePreservingBrowserOnly: browser-only items',
    { items: browserOnlyItems.map(i => ({ id: i.id, category: i.category })) }
  );
  const storage = PerAccountLocalStorage.getInstance();

  // Snapshot browser assignments for browser-only items BEFORE overwriting
  const existingAssignments = storage.get<BookmarkAssignment[]>(
    PerAccountStorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS,
    []
  );
  const existingFolders = storage.get<BookmarkFolder[]>(
    PerAccountStorageKeys.BOOKMARK_FOLDERS,
    []
  );
  const existingRootOrder = storage.get<RootOrderItem<'bookmark'>[]>(
    PerAccountStorageKeys.BOOKMARK_ROOT_ORDER,
    []
  );

  // Map browser-only item IDs → their current folder assignment (or root)
  const browserOnlyIds = new Set(browserOnlyItems.map(b => b.id));
  const browserOnlyFolderAssignments = new Map<
    string,
    { folderId: string; folderName: string }
  >();
  const browserOnlyInRoot = new Set<string>();

  for (const assignment of existingAssignments) {
    if (browserOnlyIds.has(assignment.bookmarkId)) {
      const folder = existingFolders.find(f => f.id === assignment.folderId);
      if (folder) {
        browserOnlyFolderAssignments.set(assignment.bookmarkId, {
          folderId: assignment.folderId,
          folderName: folder.name,
        });
      }
    }
  }
  for (const orderItem of existingRootOrder) {
    if (orderItem.type === 'bookmark' && browserOnlyIds.has(orderItem.id)) {
      browserOnlyInRoot.add(orderItem.id);
    }
  }

  diagLog(
    'lists',
    'mergeRelayBookmarkStructurePreservingBrowserOnly: snapshot before applyRelayFetchResult',
    {
      assignmentCount: existingAssignments.length,
      folders: existingFolders.map(f => f.name),
      rootOrderLength: existingRootOrder.length,
    }
  );

  // Apply relay folder structure (this overwrites everything)
  applyRelayFetchResult(relayItems, undefined, categories);

  // Re-add browser-only items' folder assignments
  if (browserOnlyFolderAssignments.size === 0 && browserOnlyInRoot.size === 0)
    return;

  const newFolders = storage.get<BookmarkFolder[]>(
    PerAccountStorageKeys.BOOKMARK_FOLDERS,
    []
  );
  const newAssignments = storage.get<BookmarkAssignment[]>(
    PerAccountStorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS,
    []
  );
  const newRootOrder = storage.get<RootOrderItem<'bookmark'>[]>(
    PerAccountStorageKeys.BOOKMARK_ROOT_ORDER,
    []
  );

  const folderNameToId = new Map<string, string>();
  for (const f of newFolders) {
    folderNameToId.set(f.name, f.id);
  }

  const extraFolders: BookmarkFolder[] = [];
  const extraAssignments: BookmarkAssignment[] = [];
  const extraRootOrder: RootOrderItem<'bookmark'>[] = [];

  for (const [bookmarkId, info] of browserOnlyFolderAssignments) {
    let folderId = folderNameToId.get(info.folderName);
    if (!folderId) {
      folderId = info.folderId;
      extraFolders.push({
        id: folderId,
        name: info.folderName,
        createdAt: Date.now(),
      });
      extraRootOrder.push({ type: 'folder', id: folderId });
      folderNameToId.set(info.folderName, folderId);
    }
    const orderInFolder = [...newAssignments, ...extraAssignments].filter(
      a => a.folderId === folderId
    ).length;
    extraAssignments.push({
      bookmarkId,
      folderId: folderId!,
      order: orderInFolder,
    });
  }

  for (const bookmarkId of browserOnlyInRoot) {
    extraRootOrder.push({ type: 'bookmark', id: bookmarkId });
  }

  diagLog(
    'lists',
    'mergeRelayBookmarkStructurePreservingBrowserOnly: re-adding after applyRelayFetchResult',
    {
      extraFolders: extraFolders.map(f => f.name),
      extraAssignments,
      extraRootOrder,
    }
  );

  if (extraFolders.length > 0) {
    storage.set(PerAccountStorageKeys.BOOKMARK_FOLDERS, [
      ...newFolders,
      ...extraFolders,
    ]);
  }
  if (extraAssignments.length > 0) {
    storage.set(PerAccountStorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS, [
      ...newAssignments,
      ...extraAssignments,
    ]);
  }
  if (extraRootOrder.length > 0) {
    storage.set(PerAccountStorageKeys.BOOKMARK_ROOT_ORDER, [
      ...newRootOrder,
      ...extraRootOrder,
    ]);
  }

  SystemLogger.getInstance().info(
    'bookmarks.ts',
    `Merged relay folders, preserved ${extraAssignments.length + browserOnlyInRoot.size} browser-only bookmark assignments`
  );
}

// =============================================================================
// RELAY OPERATIONS (NIP-51 kind:30003)
// =============================================================================

/**
 * Check if private bookmarks feature is enabled
 */
export function isPrivateBookmarksEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(
    PerAccountStorageKeys.PRIVATE_BOOKMARKS_ENABLED,
    false
  );
}

/**
 * Set private bookmarks feature flag
 */
export function setPrivateBookmarksEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(
    PerAccountStorageKeys.PRIVATE_BOOKMARKS_ENABLED,
    enabled
  );
}

/**
 * Check if a note is bookmarked
 */
export function isNoteBookmarked(noteId: string): BookmarkStatus {
  const item = readBrowserBookmarks().find(b => b.id === noteId);
  if (!item) return { public: false, private: false };
  return { public: !item.isPrivate, private: item.isPrivate ?? false };
}

/**
 * Add a bookmark
 */
export async function addBookmark(
  noteId: string,
  isPrivate: boolean,
  category: string = '',
  tagType: 'e' | 'a' = 'e',
  description?: string
): Promise<boolean> {
  requireAuth();

  const items = readBrowserBookmarks();
  if (items.some(b => b.id === noteId)) return true;

  items.push({
    id: noteId,
    type: tagType,
    value: noteId,
    addedAt: now(),
    isPrivate,
    category,
    ...(description ? { description } : {}),
  });
  writeBrowserBookmarks(items);
  getBookmarkFolderService().ensureBookmarkAssignment(noteId);

  logger.info(
    'bookmarks.ts',
    `Added ${isPrivate ? 'private' : 'public'} bookmark to "${category || 'root'}": ${noteId}`
  );
  return true;
}

/**
 * Remove a bookmark
 */
export async function removeBookmark(noteId: string): Promise<boolean> {
  requireAuth();

  const items = readBrowserBookmarks();
  writeBrowserBookmarks(items.filter(b => b.id !== noteId));

  // Remove folder assignment
  getBookmarkFolderService().removeBookmarkAssignment(noteId);

  logger.info('bookmarks.ts', `Removed bookmark: ${noteId}`);
  return true;
}

/**
 * Get all bookmarks with status
 */
export function getAllBookmarksWithStatus(): Map<
  string,
  { public: boolean; private: boolean }
> {
  const result = new Map<string, { public: boolean; private: boolean }>();
  for (const item of readBrowserBookmarks()) {
    result.set(item.id, {
      public: !item.isPrivate,
      private: item.isPrivate || false,
    });
  }
  return result;
}

/**
 * Load browser bookmarks from file if empty
 */
async function ensureBrowserBookmarksLoaded(): Promise<BookmarkItem[]> {
  const items = readBrowserBookmarks();
  if (items.length > 0) return items;

  const fileItems = await getAllBookmarksFromFile();
  if (fileItems.length > 0) {
    writeBrowserBookmarks(fileItems);
    return fileItems;
  }
  return items;
}

/**
 * Get all bookmark IDs
 */
export async function getAllBookmarkIds(): Promise<string[]> {
  const items = await ensureBrowserBookmarksLoaded();
  return items.map(item => item.id);
}

/**
 * Get all bookmarks with metadata
 */
export async function getAllBookmarksWithMetadata(): Promise<
  BookmarkWithMetadata[]
> {
  const items = await ensureBrowserBookmarksLoaded();
  return items.map(item => {
    const meta: BookmarkWithMetadata = {
      id: item.id,
      isPrivate: item.isPrivate || false,
    };
    if (item.category !== undefined) meta.category = item.category;
    return meta;
  });
}

/**
 * Build BookmarkSetData from localStorage
 */
function buildSetDataFromLocalStorage(): BookmarkSetData {
  const allItems = readBrowserBookmarks();
  const folderService = getBookmarkFolderService();
  const existingFolders = folderService.getFolders();
  const allAssignments = folderService.getBookmarksInFolder('');
  const allRootOrder = folderService.getRootOrder();
  diagLog('lists', 'buildSetDataFromLocalStorage START', {
    itemCount: allItems.length,
    folders: existingFolders.map(f => ({ id: f.id, name: f.name })),
    rootAssignments: allAssignments,
    rootOrder: allRootOrder,
  });
  const itemMap = new Map(allItems.map(item => [item.id, item]));
  const setsMap = new Map<string, BookmarkSet>();

  // Initialize root set and folder sets
  setsMap.set('', createEmptySet(''));
  for (const folder of existingFolders) {
    setsMap.set(folder.name, createEmptySet(folder.name));
  }

  const assignedItemIds = new Set<string>();

  const addItemToSet = (set: BookmarkSet, item: BookmarkItem): void => {
    const tag: BookmarkTag = {
      type: item.type,
      value: item.value,
      ...(item.description && { description: item.description }),
    };
    (item.isPrivate ? set.privateTags : set.publicTags).push(tag);
  };

  const processFolder = (folderId: string, set: BookmarkSet): void => {
    const folderBookmarkIds = folderService.getBookmarksInFolder(folderId);
    diagLog('lists', 'buildSetDataFromLocalStorage processFolder', {
      folderId,
      dTag: set.d,
      itemsFound: folderBookmarkIds,
    });
    for (const bookmarkId of folderBookmarkIds) {
      const item = itemMap.get(bookmarkId);
      if (item) {
        addItemToSet(set, item);
        assignedItemIds.add(bookmarkId);
      }
    }
  };

  // Process each folder and root items
  for (const folder of existingFolders) {
    processFolder(folder.id, setsMap.get(folder.name)!);
  }
  processFolder('', setsMap.get('')!);

  // Handle orphaned items - add to root
  const rootSet = setsMap.get('')!;
  const orphanedItems = allItems.filter(item => !assignedItemIds.has(item.id));
  diagLog('lists', 'buildSetDataFromLocalStorage orphaned items', {
    ids: orphanedItems.map(i => i.id),
  });
  for (const item of orphanedItems) {
    addItemToSet(rootSet, item);
    folderService.ensureBookmarkAssignment(item.id);
  }

  // Build setOrder from rootOrder
  const rootOrder = folderService.getRootOrder();
  const folderNames = rootOrder
    .filter(item => item.type === 'folder')
    .map(item => existingFolders.find(f => f.id === item.id)?.name)
    .filter((name): name is string => !!name);
  const setOrder = ['', ...folderNames];

  const result: BookmarkSetData = {
    version: 2,
    sets: Array.from(setsMap.values()),
    metadata: {
      setOrder,
      lastModified: now(),
    },
  };
  diagLog('lists', 'buildSetDataFromLocalStorage END', {
    setOrder,
    sets: result.sets.map(s => ({
      d: s.d,
      publicTags: s.publicTags.length,
      privateTags: s.privateTags.length,
      publicTagValues: s.publicTags.map(t => [t.type, t.value, t.description]),
      privateTagValues: s.privateTags.map(t => [
        t.type,
        t.value,
        t.description,
      ]),
    })),
  });
  return result;
}

/**
 * Encrypt private items for relay publishing
 */
async function encryptPrivateItems(
  items: BookmarkItem[],
  pubkey: string
): Promise<string> {
  diagLog('lists', 'encryptPrivateItems', {
    items: items.map(i => ({
      type: i.type,
      value: i.value,
      description: i.description,
    })),
  });
  if (items.length === 0) return '';
  const tags = items.map(item =>
    item.description
      ? [item.type, item.value, item.description]
      : [item.type, item.value]
  );
  return encryptContent(JSON.stringify(tags), pubkey);
}

/**
 * Decrypt private items from relay event
 */
async function decryptPrivateItems(
  event: NostrEvent,
  pubkey: string
): Promise<BookmarkItem[]> {
  if (!event.content?.trim()) {
    diagLog('lists', 'decryptPrivateItems: empty content, skipping');
    return [];
  }

  diagLog('lists', 'decryptPrivateItems: attempting decryption', {
    contentLength: event.content.length,
  });
  const decrypted = await decryptContent(event.content, pubkey);
  if (!decrypted) {
    diagLog(
      'lists',
      'decryptPrivateItems: decryption returned null — private items LOST'
    );
    return [];
  }

  try {
    const tags = JSON.parse(decrypted) as string[][];
    const items = tagsToItems(tags, event.created_at);
    diagLog('lists', 'decryptPrivateItems: SUCCESS', {
      itemCount: items.length,
      tagCount: tags.length,
    });
    return items;
  } catch (error) {
    diagLog('lists', 'decryptPrivateItems: FAILED to parse decrypted content', {
      error: String(error),
      rawPreview: decrypted.slice(0, 200),
    });
    logger.error('bookmarks.ts', `Failed to parse decrypted content: ${error}`);
    return [];
  }
}

/**
 * Save bookmarks to file (in BookmarkSetData format)
 */
export async function saveBookmarksToFile(): Promise<void> {
  const setData = buildSetDataFromLocalStorage();
  await writeBookmarkFile(setData);
  logger.info('bookmarks.ts', `Saved to file: ${setData.sets.length} sets`);
}

// ============================================================
// Client-side tombstones for deleted bookmark folders.
// Honors the user's intent ("I deleted this") locally and independently of
// what relays still serve. NIP-09's created_at-based deletion leaves a gap
// any later kind:30003 event with a newer timestamp resurrects the folder.
// Tombstones plug that gap on every machine where the user explicitly deleted.
// Re-creating a folder with the same name clears its tombstone.
// See docs/features/lists.md "Folder-Resurrection".
// ============================================================

function getBookmarkTombstones(): Record<string, number> {
  return PerAccountLocalStorage.getInstance().get<Record<string, number>>(
    PerAccountStorageKeys.BOOKMARK_TOMBSTONES,
    {}
  );
}

function setBookmarkTombstones(map: Record<string, number>): void {
  PerAccountLocalStorage.getInstance().set(
    PerAccountStorageKeys.BOOKMARK_TOMBSTONES,
    map
  );
}

export function isBookmarkFolderTombstoned(folderName: string): boolean {
  if (!folderName) return false;
  return folderName in getBookmarkTombstones();
}

export function addBookmarkFolderTombstone(folderName: string): void {
  if (!folderName) return;
  const map = getBookmarkTombstones();
  map[folderName] = Math.floor(Date.now() / 1000);
  setBookmarkTombstones(map);
  diagLog('lists', 'addBookmarkFolderTombstone', {
    folderName,
    total: Object.keys(map).length,
  });
  // Mirror into the shared, durable deletion record so the delete propagates
  // to the user's other devices (best-effort, never blocks the local mutation).
  publishBookmarkDeletionChange(folderName, true);
}

export function removeBookmarkFolderTombstone(folderName: string): void {
  if (!folderName) return;
  const map = getBookmarkTombstones();
  if (!(folderName in map)) return;
  delete map[folderName];
  setBookmarkTombstones(map);
  diagLog('lists', 'removeBookmarkFolderTombstone', {
    folderName,
    remaining: Object.keys(map).length,
  });
  // Mirror the revival (explicit re-creation) so it overrides the deletion on
  // every device. Only fires when an actual tombstone was cleared (guard above).
  publishBookmarkDeletionChange(folderName, false);
}

// Shared cross-device deletion record (NIP-78 kind:30078) — see src/lists/listDeletionRecord.ts.
// Bookmarks and tribes share one implementation; this just binds it to the bookmark
// tombstone map. The thin wrappers keep the original call-site names unchanged.
const BOOKMARK_DELETION_CONFIG: DeletionRecordConfig = {
  dTag: 'noornote:bookmark-deletions',
  alt: 'NoorNote deleted bookmark folders',
  logLabel: 'bookmark-deletions',
  getLocalTombstones: getBookmarkTombstones,
  setLocalTombstones: setBookmarkTombstones,
};

/** Fire-and-forget mirror of a local tombstone add/remove into the shared record. */
function publishBookmarkDeletionChange(
  folderName: string,
  deleted: boolean
): void {
  publishDeletionChange(BOOKMARK_DELETION_CONFIG, folderName, deleted);
}

/** Pull the shared deletion record into the local tombstone map (before the fetch filter). */
function syncBookmarkDeletionsIntoLocal(pubkey: string): Promise<void> {
  return syncDeletionsIntoLocal(BOOKMARK_DELETION_CONFIG, pubkey);
}

/**
 * Publish bookmarks to relays (NIP-51)
 */
export async function publishBookmarksToRelays(
  callerTag: string = 'unknown'
): Promise<void> {
  diagLog('lists', 'publishBookmarksToRelays: START', { callerTag });
  const { pubkey } = requireAuth();
  diagLog('lists', 'publishBookmarksToRelays: auth ok', {
    pubkey: pubkey.slice(0, 8),
  });
  const writeRelays = getWriteRelays();
  if (writeRelays.length === 0) {
    diagLog('lists', 'publishBookmarksToRelays: FAILED — no write relays');
    throw new Error('No write relays available');
  }
  diagLog('lists', 'publishBookmarksToRelays: write relays', {
    count: writeRelays.length,
  });

  const setData = buildSetDataFromLocalStorage();
  diagLog('lists', 'publishBookmarksToRelays: full setData', {
    setOrder: setData.metadata.setOrder,
    sets: setData.sets.map(s => ({
      d: s.d,
      publicTags: s.publicTags,
      privateTags: s.privateTags,
    })),
  });

  // REMOVED 2026-04-30: conditional kind:5 publish based on local-vs-relay folder diff.
  //
  // The previous code did:
  //   const relayResult = await fetchBookmarksFromRelays(pubkey);
  //   const deletedCategories = relayResult.categories.filter(c => !localCategories.has(c));
  //   if (deletedCategories.length) DeletionService.deleteByCoordinates(...)
  //
  // Treating "relay-has-but-local-doesn't" as a delete is destructive whenever the
  // local state is stale relative to the relay — e.g. cross-device: device A creates
  // a folder, device B's localStorage hasn't applied the new state yet, B publishes
  // for any unrelated reason → kind:5 nukes A's folder for everyone.
  //
  // Confirmed root cause of the mass-delete incident on 2026-04-30: Mobile's
  // publishBookmarksToRelays wiped Portfolio/Personal/Nostr Apps from relays at
  // 13:17:42 UTC because Mobile's localStorage didn't have them at that moment.
  //
  // Explicit user deletes are covered by the eager kind:5 in
  // BookmarkManager.deleteFolder / editFolder (added 2026-04-29 — Step 1).
  //
  // See docs/features/lists.md "Folder-Resurrection" + "Eager kind:5 deletion publish".
  diagLog(
    'lists',
    'publishBookmarksToRelays: skipping conditional kind:5 — destructive cross-device path removed'
  );

  // Publish-side self-correction (2026-05-01): fetch the latest kind:5
  // deletions from relays and drop any set whose coordinate has a deletion
  // newer than this device's local folder.createdAt. This catches stale
  // tabs that still have a deleted folder in their localStorage and would
  // otherwise re-publish it (= resurrection).
  //
  // Legit re-creation still works: createFolder sets createdAt = now, so
  // a freshly created folder's createdAt > any past deletion → publish proceeds.
  const activeDeletions = new Map<string, number>();
  try {
    const deletionEvents = await fetchEvents(
      [{ authors: [pubkey], kinds: [5] }],
      5000,
      true
    );
    for (const ev of deletionEvents) {
      for (const tag of ev.tags) {
        if (tag[0] !== 'a' || !tag[1]?.startsWith('30003:')) continue;
        const coord = tag[1];
        const existing = activeDeletions.get(coord);
        if (!existing || ev.created_at > existing)
          activeDeletions.set(coord, ev.created_at);
      }
    }
  } catch (err) {
    diagLog(
      'lists',
      'publishBookmarksToRelays: deletion pre-fetch FAILED — proceeding without self-correction',
      { error: String(err) }
    );
  }

  const folderService = getBookmarkFolderService();
  const localFolders = folderService.getFolders();
  const skippedSets: string[] = [];
  const skippedTombstoned: string[] = [];

  const filteredSets = setData.sets.filter(set => {
    if (set.d === '') return true; // root set always publishes

    // (1) Client-side tombstone — hard veto. If the user deleted this folder
    // on this device, never publish it (even if it somehow slipped back into
    // setData via a stale apply path).
    if (isBookmarkFolderTombstoned(set.d)) {
      skippedTombstoned.push(set.d);
      return false;
    }

    // (2) Publish-side self-correction against stale-tab republishes that
    // never went through deleteFolder on this device. See lists.md.
    const coordinate = `30003:${pubkey}:${set.d}`;
    const deletionTs = activeDeletions.get(coordinate);
    if (deletionTs === undefined) return true; // no deletion → publish

    const folder = localFolders.find(f => f.name === set.d);
    // folder.createdAt is in ms, deletion timestamp is in seconds
    const folderCreatedAtSec = folder?.createdAt
      ? Math.floor(folder.createdAt / 1000)
      : 0;
    if (folderCreatedAtSec > deletionTs) return true; // legit re-creation → publish

    skippedSets.push(set.d);
    return false; // stale — skip to prevent resurrection
  });

  if (skippedTombstoned.length > 0) {
    diagLog(
      'lists',
      'publishBookmarksToRelays: skipped sets due to client-side tombstone',
      {
        skipped: skippedTombstoned,
        callerTag,
      }
    );
    logger.warn(
      'bookmarks.ts',
      `Skipped ${skippedTombstoned.length} tombstoned bookmark set(s): ${skippedTombstoned.join(', ')}`
    );
  }

  if (skippedSets.length > 0) {
    diagLog(
      'lists',
      'publishBookmarksToRelays: skipped sets due to active relay deletion (anti-resurrection)',
      {
        skipped: skippedSets,
        activeDeletionCount: activeDeletions.size,
        callerTag,
      }
    );
    logger.warn(
      'bookmarks.ts',
      `Skipped ${skippedSets.length} bookmark set(s) due to relay deletion: ${skippedSets.join(', ')}`
    );
  }

  logger.info('bookmarks.ts', `Publishing: ${filteredSets.length} sets`);

  let totalPublished = 0;
  for (const set of filteredSets) {
    if (
      set.publicTags.length === 0 &&
      set.privateTags.length === 0 &&
      set.d !== ''
    )
      continue;

    diagLog('lists', 'publishBookmarksToRelays: publishing set', {
      dTag: set.d,
      publicTagCount: set.publicTags.length,
      privateTagCount: set.privateTags.length,
      publicTags: set.publicTags.map(t => [t.type, t.value, t.description]),
    });
    const tags: string[][] = [
      ['d', set.d],
      ['title', set.d],
    ];
    for (const tag of set.publicTags) {
      tags.push(
        tag.description
          ? [tag.type, tag.value, tag.description]
          : [tag.type, tag.value]
      );
    }

    let content = '';
    if (set.privateTags.length > 0) {
      diagLog('lists', 'publishBookmarksToRelays: encrypting private tags', {
        count: set.privateTags.length,
        category: set.d,
      });
      content = await encryptPrivateItems(
        set.privateTags.map(t => ({
          id: t.value,
          type: t.type,
          value: t.value,
          isPrivate: true,
        })),
        pubkey
      );
      diagLog('lists', 'publishBookmarksToRelays: encrypted content', {
        length: content.length,
      });
    }

    diagLog('lists', 'publishBookmarksToRelays: signing event', {
      category: set.d,
      tagCount: tags.length,
      hasContent: content.length > 0,
    });
    let signed;
    try {
      signed = await signEvent({
        kind: 30003,
        created_at: now(),
        tags,
        content,
        pubkey,
      });
    } catch (signError) {
      diagLog('lists', 'publishBookmarksToRelays: signEvent THREW', {
        category: set.d,
        error: String(signError),
      });
      logger.error(
        'bookmarks.ts',
        `Sign event threw for category: ${set.d}: ${signError}`
      );
      continue;
    }
    if (!signed) {
      diagLog('lists', 'publishBookmarksToRelays: signEvent returned null', {
        category: set.d,
      });
      logger.error(
        'bookmarks.ts',
        `Failed to sign event for category: ${set.d}`
      );
      continue;
    }

    diagLog('lists', 'publishBookmarksToRelays: publishing signed event', {
      category: set.d,
      eventId: signed.id?.slice(0, 8),
    });
    try {
      await publishEvent(signed);
    } catch (pubError) {
      diagLog('lists', 'publishBookmarksToRelays: publishEvent THREW', {
        category: set.d,
        error: String(pubError),
      });
      throw pubError;
    }
    totalPublished++;
    logger.info(
      'bookmarks.ts',
      `Published category "${set.d || 'root'}": ${set.publicTags.length} public + ${set.privateTags.length} private`
    );
  }

  logger.info(
    'bookmarks.ts',
    `Published ${totalPublished} bookmark set events to relays`
  );

  // Publish folder order metadata (NIP-78 kind:30078) — exclude tombstoned
  // folders so they don't reappear via the order event after suppression.
  const folderOrder = setData.metadata.setOrder
    .filter(d => d !== '')
    .filter(d => !isBookmarkFolderTombstoned(d));
  diagLog('lists', 'publishBookmarksToRelays: folder order for kind:30078', {
    folderOrder,
  });
  if (folderOrder.length > 0) {
    const orderTags: string[][] = [
      ['d', 'noornote:bookmark-folders-order'],
      ...folderOrder.map(dTag => ['a', `30003:${pubkey}:${dTag}`]),
    ];

    const publishTimestamp = now();
    // Store order in content JSON — tag order is NOT preserved by all relays
    const orderContent = JSON.stringify({ order: folderOrder });
    const signedOrderEvent = await signEvent({
      kind: 30078,
      created_at: publishTimestamp,
      tags: orderTags,
      content: orderContent,
      pubkey,
    });
    if (signedOrderEvent) {
      diagLog('lists', 'publishBookmarksToRelays: kind:30078 PUBLISH details', {
        created_at: publishTimestamp,
        created_at_ISO: new Date(publishTimestamp * 1000).toISOString(),
        tagOrder: orderTags
          .filter(t => t[0] === 'a')
          .map(t => t[1]?.split(':')[2]),
        content: orderContent,
        eventId: signedOrderEvent.id,
      });
      await publishEvent(signedOrderEvent);
      logger.info(
        'bookmarks.ts',
        `Published folder order metadata (kind:30078) with ${folderOrder.length} folders`
      );
    }
  }
}

/**
 * Fetch bookmarks from relays
 */
export async function fetchBookmarksFromRelays(
  pubkey: string
): Promise<FetchFromRelaysResult> {
  try {
    // Fetch ALL kind:30003 events (skipCache=true for sync)
    const events = await fetchEvents(
      [
        {
          authors: [pubkey],
          kinds: [30003],
          limit: 100,
        },
      ],
      10000,
      true
    );

    diagLog('lists', 'fetchBookmarksFromRelays: raw event count received', {
      count: events.length,
    });

    // Fetch deletion events (kind:5) - also skip cache
    const deletionEvents = await fetchEvents(
      [
        {
          authors: [pubkey],
          kinds: [5],
        },
      ],
      5000,
      true
    );

    // Extract deleted coordinates with deletion timestamp
    const deletedCoordinates = new Map<string, number>();
    for (const deletionEvent of deletionEvents) {
      for (const tag of deletionEvent.tags) {
        if (tag[0] !== 'a' || !tag[1]?.startsWith('30003:')) continue;
        const coordinate = tag[1];
        const existingTimestamp = deletedCoordinates.get(coordinate);
        if (
          !existingTimestamp ||
          deletionEvent.created_at > existingTimestamp
        ) {
          deletedCoordinates.set(coordinate, deletionEvent.created_at);
        }
      }
    }

    diagLog('lists', 'fetchBookmarksFromRelays: deletion events', {
      count: deletionEvents.length,
      deletedCoordinates: Array.from(deletedCoordinates.entries()),
    });
    if (deletedCoordinates.size > 0) {
      logger.info(
        'bookmarks.ts',
        `Found ${deletedCoordinates.size} deletion requests for bookmark sets`
      );
    }

    // Pull the shared cross-device deletion record into local tombstones BEFORE the
    // tombstone filter below, so folders deleted on another device are suppressed here
    // too (and a fresh/reinstalled device honours past deletions). Best-effort.
    try {
      await syncBookmarkDeletionsIntoLocal(pubkey);
    } catch (delErr) {
      diagLog(
        'lists',
        'fetchBookmarksFromRelays: deletion-record sync FAILED',
        { error: String(delErr) }
      );
    }

    if (events.length === 0 && deletedCoordinates.size === 0) {
      logger.info('bookmarks.ts', 'No bookmark sets found on relays');
      return { items: [], relayContentWasEmpty: true, relayTimestamp: 0 };
    }

    // Deduplicate by d-tag and filter out deleted ones
    const eventsByDTag = new Map<string, NostrEvent>();
    let filteredDeletedCount = 0;
    let filteredTombstonedCount = 0;
    const tombstonedSkipped: string[] = [];

    for (const event of events) {
      const dTag = getTag(event.tags, 'd');

      // (1) Client-side tombstone filter (Schritt 2, 2026-05-11): if the user
      // explicitly deleted this folder on this device, suppress every event for
      // it regardless of created_at. createFolder/rename clear the tombstone
      // when the user revives the name, so legit re-creation stays intact.
      if (dTag && isBookmarkFolderTombstoned(dTag)) {
        filteredTombstonedCount++;
        tombstonedSkipped.push(dTag);
        continue;
      }

      // (2) NIP-09 created_at-based suppression: events older than a deletion
      // are dropped per spec. Resurrection events newer than the deletion slip
      // through here — the tombstone above is what stops those on this device.
      const coordinate = `30003:${pubkey}:${dTag}`;
      const deletionTimestamp = deletedCoordinates.get(coordinate);
      if (
        deletionTimestamp !== undefined &&
        event.created_at < deletionTimestamp
      ) {
        filteredDeletedCount++;
        continue;
      }

      const existing = eventsByDTag.get(dTag);
      if (!existing || event.created_at > existing.created_at) {
        eventsByDTag.set(dTag, event);
      }
    }

    if (filteredTombstonedCount > 0) {
      diagLog('lists', 'fetchBookmarksFromRelays: suppressed by tombstone', {
        count: filteredTombstonedCount,
        dTags: tombstonedSkipped,
      });
      logger.info(
        'bookmarks.ts',
        `Suppressed ${filteredTombstonedCount} tombstoned bookmark set(s) from relay fetch: ${tombstonedSkipped.join(', ')}`
      );
    }

    diagLog('lists', 'fetchBookmarksFromRelays: events after d-tag dedup', {
      count: eventsByDTag.size,
      dTags: Array.from(eventsByDTag.keys()),
      filteredDeletedCount,
    });
    if (filteredDeletedCount > 0) {
      logger.info(
        'bookmarks.ts',
        `Filtered out ${filteredDeletedCount} deleted bookmark sets from relay fetch`
      );
    }

    if (eventsByDTag.size === 0) {
      logger.info('bookmarks.ts', 'No bookmark sets after filtering deletions');
      return { items: [], relayContentWasEmpty: true, relayTimestamp: 0 };
    }

    // Fetch folder order metadata (NIP-78 kind:30078) - also skip cache
    const orderEvents = await fetchEvents(
      [
        {
          authors: [pubkey],
          kinds: [30078],
          '#d': ['noornote:bookmark-folders-order'],
        },
      ],
      5000,
      true
    );

    let folderOrder: string[] = [];
    const sortedOrderEvents = orderEvents.sort(
      (a, b) => b.created_at - a.created_at
    );
    const orderEvent = sortedOrderEvents[0];
    if (orderEvent) {
      // Prefer content-based order (reliable) — tag order is NOT preserved by all relays
      let usedContentOrder = false;
      if (orderEvent.content) {
        try {
          const parsed = JSON.parse(orderEvent.content);
          if (Array.isArray(parsed.order) && parsed.order.length > 0) {
            folderOrder = parsed.order;
            usedContentOrder = true;
          }
        } catch {
          /* not JSON, fall through to tag-based extraction */
        }
      }

      if (!usedContentOrder) {
        // Legacy fallback: extract from tag order (unreliable — relays may sort tags)
        folderOrder = orderEvent.tags
          .filter(
            (t): t is [string, string, ...string[]] =>
              t[0] === 'a' && !!t[1]?.startsWith('30003:')
          )
          .map(t => {
            const parts = t[1].split(':');
            return parts[2] || '';
          });
      }

      logger.info(
        'bookmarks.ts',
        `Loaded folder order from NIP-78 metadata (${usedContentOrder ? 'content' : 'tags'}): ${folderOrder.join(', ')}`
      );
    }

    diagLog('lists', 'fetchBookmarksFromRelays: NIP-78 event details', {
      totalEventsReturned: orderEvents.length,
      selectedCreatedAt: orderEvent?.created_at,
      selectedCreatedAtISO: orderEvent
        ? new Date(orderEvent.created_at * 1000).toISOString()
        : 'none',
      allEventTimestamps: orderEvents.map(e => ({
        created_at: e.created_at,
        iso: new Date(e.created_at * 1000).toISOString(),
      })),
      rawTags: orderEvent?.tags,
      folderOrder,
    });

    // Build categories array in correct order (root always first)
    const categories: string[] = [''];
    if (folderOrder.length > 0) {
      categories.push(...folderOrder);
      // Add any folders not in metadata
      for (const dTag of eventsByDTag.keys()) {
        if (dTag !== '' && !categories.includes(dTag)) {
          categories.push(dTag);
          logger.warn(
            'bookmarks.ts',
            `Folder "${dTag}" not in order metadata, appending to end`
          );
        }
      }
    } else {
      categories.push(
        ...Array.from(eventsByDTag.keys())
          .filter(d => d !== '')
          .sort()
      );
      logger.info(
        'bookmarks.ts',
        'No folder order metadata found, using alphabetical fallback'
      );
    }

    const allItems: BookmarkItem[] = [];
    const categoryAssignments = new Map<string, string>();

    const assignCategory = (
      items: BookmarkItem[],
      categoryName: string,
      isPrivate: boolean
    ): void => {
      for (const item of items) {
        item.isPrivate = isPrivate;
        item.category = categoryName;
        categoryAssignments.set(item.id, categoryName);
      }
    };

    for (const categoryName of categories) {
      const event = eventsByDTag.get(categoryName);
      if (!event) continue;

      const hasContent = !!event.content?.trim();

      const publicItems = tagsToItems(
        event.tags.filter(t => t[0] !== 'd' && t[0] !== 'title'),
        event.created_at
      );
      assignCategory(publicItems, categoryName, false);

      let privateItems: BookmarkItem[] = [];
      if (hasContent) {
        diagLog(
          'lists',
          'fetchBookmarksFromRelays: category has encrypted content, decrypting',
          { category: categoryName, contentLength: event.content.length }
        );
        try {
          privateItems = await decryptPrivateItems(event, pubkey);
          assignCategory(privateItems, categoryName, true);
        } catch (error) {
          diagLog('lists', 'fetchBookmarksFromRelays: DECRYPT FAILED', {
            category: categoryName,
            error: String(error),
          });
          logger.error(
            'bookmarks.ts',
            `Failed to decrypt private items for category "${categoryName}": ${error}`
          );
        }
      } else {
        diagLog(
          'lists',
          'fetchBookmarksFromRelays: category has no encrypted content',
          { category: categoryName }
        );
      }

      allItems.push(...publicItems, ...privateItems);
      diagLog('lists', 'fetchBookmarksFromRelays: category items', {
        category: categoryName,
        publicItems: publicItems.map(i => ({
          id: i.id,
          category: i.category,
          isPrivate: i.isPrivate,
          description: i.description,
        })),
        privateItems: privateItems.map(i => ({
          id: i.id,
          category: i.category,
          isPrivate: i.isPrivate,
          description: i.description,
        })),
      });
      logger.info(
        'bookmarks.ts',
        `Fetched category "${categoryName || 'root'}": ${publicItems.length} public + ${privateItems.length} private`
      );
    }

    diagLog('lists', 'fetchBookmarksFromRelays: final categories array', {
      categories,
    });

    // Deduplicate by ID
    const deduped = deduplicateById(allItems);

    diagLog('lists', 'fetchBookmarksFromRelays: final deduped result', {
      count: deduped.length,
      items: deduped.map(i => ({
        id: i.id,
        category: i.category,
        isPrivate: i.isPrivate,
        description: i.description,
      })),
    });

    // Compute relay timestamp: MAX created_at across all bookmark events
    let maxEventTimestamp = 0;
    for (const event of eventsByDTag.values()) {
      if (event.created_at > maxEventTimestamp)
        maxEventTimestamp = event.created_at;
    }

    // RESURRECTION DETECTION (logging only, no behavior change) — see docs/features/lists.md "Folder-Resurrection"
    const browserFolderNames = new Set(
      getBookmarkFolderService()
        .getFolders()
        .map(f => f.name)
    );
    const relayFolderNames = categories.filter(c => c !== '');
    const resurrectionCandidates = relayFolderNames.filter(
      name => !browserFolderNames.has(name)
    );
    if (resurrectionCandidates.length > 0 && browserFolderNames.size > 0) {
      console.debug(
        '[Lists] Possible folder resurrection in bookmarks — relay returned folders not present in local browser state',
        {
          resurrectionCandidates,
          browserFolders: [...browserFolderNames],
          relayFolders: relayFolderNames,
          eventCreatedAt: maxEventTimestamp,
        }
      );
      diagLog(
        'lists',
        'bookmarks RESURRECTION CANDIDATE in fetchBookmarksFromRelays',
        {
          resurrectionCandidates,
          browserFolders: [...browserFolderNames],
          relayFolders: relayFolderNames,
          eventCreatedAt: maxEventTimestamp,
        }
      );
    }

    return {
      items: deduped,
      relayContentWasEmpty: false,
      categoryAssignments,
      categories,
      relayTimestamp: maxEventTimestamp,
      deletedCoordinates,
    };
  } catch (error) {
    logger.error('bookmarks.ts', `Failed to fetch from relays: ${error}`);
    return { items: [], relayContentWasEmpty: true, relayTimestamp: 0 };
  }
}

// =============================================================================
// SYNC HELPERS (used by BookmarkStorageAdapter and BookmarkManager)
// =============================================================================

interface BookmarkMovedItem {
  browserItem: BookmarkItem;
  sourceItem: BookmarkItem;
}

interface BookmarkAdapterSyncDiff {
  added: BookmarkItem[];
  removed: BookmarkItem[];
  unchanged: BookmarkItem[];
  moved: BookmarkMovedItem[];
}

export interface SnapshotDiffInfo {
  hasDifference: boolean;
  isOrderOnly: boolean;
  hasFolderSetDiff: boolean;
  details: string[];
}

export interface BookmarkAdapterSyncFromRelaysResult {
  requiresConfirmation: boolean;
  snapshotDiffInfo: SnapshotDiffInfo;
  diff: BookmarkAdapterSyncDiff;
  relayItems: BookmarkItem[];
  relayContentWasEmpty: boolean;
  categoryAssignments: Map<string, string> | undefined;
  categories: string[] | undefined;
  relayTimestamp: number;
  deletedCoordinates: Map<string, number> | undefined;
}

function calculateBookmarkSyncDiff(
  browserItems: BookmarkItem[],
  sourceItems: BookmarkItem[]
): BookmarkAdapterSyncDiff {
  diagLog('lists', 'calculateBookmarkSyncDiff: inputs', {
    browserItems: browserItems.map(i => ({ id: i.id, category: i.category })),
    sourceItems: sourceItems.map(i => ({ id: i.id, category: i.category })),
  });
  const browserMap = new Map(browserItems.map(item => [item.id, item]));
  const sourceMap = new Map(sourceItems.map(item => [item.id, item]));

  const added = sourceItems.filter(item => !browserMap.has(item.id));
  const removed = browserItems.filter(item => !sourceMap.has(item.id));

  const unchanged: BookmarkItem[] = [];
  const moved: BookmarkMovedItem[] = [];

  // Get folder service to look up browser item categories from assignments
  const folderService = getBookmarkFolderService();
  const folders = folderService.getFolders();
  const folderIdToName = new Map(folders.map(f => [f.id, f.name]));

  for (const browserItem of browserItems) {
    const sourceItem = sourceMap.get(browserItem.id);
    if (sourceItem) {
      // Get browser category from folder assignments (not from item.category which is undefined)
      const browserFolderId = folderService.getBookmarkFolder(browserItem.id);
      const browserCategory = folderIdToName.get(browserFolderId) || '';
      const sourceCategory = sourceItem.category || '';
      if (browserCategory !== sourceCategory) {
        moved.push({ browserItem, sourceItem });
      } else {
        unchanged.push(browserItem);
      }
    }
  }

  const result = { added, removed, unchanged, moved };
  diagLog('lists', 'calculateBookmarkSyncDiff: result', {
    added: added.map(i => i.id),
    removed: removed.map(i => i.id),
    moved: moved.map(m => ({
      id: m.browserItem.id,
      browserCategory: m.browserItem.category,
      sourceCategory: m.sourceItem.category,
    })),
    unchangedCount: unchanged.length,
  });
  return result;
}

function mergeBookmarkItems(
  browserItems: BookmarkItem[],
  newItems: BookmarkItem[]
): BookmarkItem[] {
  return mergeByKey(browserItems, newItems, 'id');
}

// =============================================================================
// STATE SNAPSHOT COMPARISON (for detecting ANY difference)
// =============================================================================

/**
 * Complete bookmark state snapshot for comparison.
 * Captures: folder order, items per folder (with order), item properties.
 */
interface BookmarkStateSnapshot {
  folderOrder: string[]; // Folder names in order ('' = root always first)
  itemsByFolder: Map<string, string[]>; // folder name → ordered item ids
  itemProperties: Map<string, { isPrivate: boolean; description: string }>;
}

/**
 * Create snapshot from browser state (localStorage + folderService)
 */
function createBrowserBookmarkSnapshot(): BookmarkStateSnapshot {
  const folderService = getBookmarkFolderService();
  const browserItems = readBrowserBookmarks();
  const folders = folderService.getFolders();
  const rootOrder = folderService.getRootOrder();

  // Build folder order from rootOrder (folders only)
  const folderOrder: string[] = ['']; // Root always first
  for (const item of rootOrder) {
    if (item.type === 'folder') {
      const folder = folders.find(f => f.id === item.id);
      if (folder) folderOrder.push(folder.name);
    }
  }
  // Add any folders not in rootOrder
  for (const folder of folders) {
    if (!folderOrder.includes(folder.name)) {
      folderOrder.push(folder.name);
    }
  }

  // Build itemsByFolder with order
  const itemsByFolder = new Map<string, string[]>();
  itemsByFolder.set('', []); // Initialize root
  for (const folderName of folderOrder) {
    if (folderName !== '') itemsByFolder.set(folderName, []);
  }

  // Get items in root order
  for (const item of rootOrder) {
    if (item.type === 'bookmark') {
      const rootItems = itemsByFolder.get('') || [];
      rootItems.push(item.id);
      itemsByFolder.set('', rootItems);
    }
  }

  // Get items in each folder (from assignments)
  for (const folder of folders) {
    const folderItems = folderService.getBookmarksInFolder(folder.id);
    itemsByFolder.set(folder.name, folderItems);
  }

  // Build item properties map
  const itemProperties = new Map<
    string,
    { isPrivate: boolean; description: string }
  >();
  for (const item of browserItems) {
    itemProperties.set(item.id, {
      isPrivate: item.isPrivate || false,
      description: item.description || '',
    });
  }

  const snapshot = { folderOrder, itemsByFolder, itemProperties };
  diagLog('lists', 'createBrowserBookmarkSnapshot', {
    folderOrder,
    itemsByFolder: Object.fromEntries(itemsByFolder),
    itemProperties: Object.fromEntries(itemProperties),
  });
  return snapshot;
}

/**
 * Create snapshot from relay/file data (items array + categories)
 */
function createSourceBookmarkSnapshot(
  items: BookmarkItem[],
  categories?: string[]
): BookmarkStateSnapshot {
  // Build folder order from categories ('' = root always first)
  const folderOrder: string[] = categories ? [...categories] : [''];
  if (!folderOrder.includes('')) folderOrder.unshift('');

  // Group items by category, preserving order within each category
  const itemsByFolder = new Map<string, string[]>();
  for (const folderName of folderOrder) {
    itemsByFolder.set(folderName, []);
  }

  for (const item of items) {
    const category = item.category || '';
    if (!itemsByFolder.has(category)) {
      itemsByFolder.set(category, []);
      folderOrder.push(category);
    }
    itemsByFolder.get(category)!.push(item.id);
  }

  // Build item properties map
  const itemProperties = new Map<
    string,
    { isPrivate: boolean; description: string }
  >();
  for (const item of items) {
    itemProperties.set(item.id, {
      isPrivate: item.isPrivate || false,
      description: item.description || '',
    });
  }

  const snapshot = { folderOrder, itemsByFolder, itemProperties };
  diagLog('lists', 'createSourceBookmarkSnapshot', {
    folderOrder,
    itemsByFolder: Object.fromEntries(itemsByFolder),
    itemProperties: Object.fromEntries(itemProperties),
  });
  return snapshot;
}

/**
 * Detailed diff between browser and source snapshots.
 * Distinguishes order-only changes (auto-resolvable) from content changes (need modal).
 */
function getBookmarkSnapshotDiffInfo(
  sourceItems: BookmarkItem[],
  categories?: string[]
): SnapshotDiffInfo {
  const a = createBrowserBookmarkSnapshot();
  const b = createSourceBookmarkSnapshot(sourceItems, categories);

  const details: string[] = [];
  let hasContentDiff = false;
  let hasOrderDiff = false;

  // 1. Folder sets
  const aFolders = new Set(a.folderOrder);
  const bFolders = new Set(b.folderOrder);
  const newFromRelay = [...bFolders].filter(f => !aFolders.has(f));
  const onlyInBrowser = [...aFolders].filter(f => !bFolders.has(f));
  if (newFromRelay.length > 0) {
    hasContentDiff = true;
    details.push(`New folders from relay: ${newFromRelay.join(', ')}`);
  }
  if (onlyInBrowser.length > 0) {
    hasContentDiff = true;
    details.push(`Folders only in browser: ${onlyInBrowser.join(', ')}`);
  }

  // 2. Folder order (compare common folders in both)
  const aCommonOrder = a.folderOrder.filter(f => bFolders.has(f));
  const bCommonOrder = b.folderOrder.filter(f => aFolders.has(f));
  if (
    aCommonOrder.length > 0 &&
    aCommonOrder.some((f, i) => f !== bCommonOrder[i])
  ) {
    hasOrderDiff = true;
    details.push('Folder order differs');
  }

  // 3. Items per folder
  for (const [folderName, aItems] of a.itemsByFolder) {
    const bItems = b.itemsByFolder.get(folderName);
    if (!bItems) continue; // folder missing handled above
    const aSet = new Set(aItems);
    const bSet = new Set(bItems);
    const newItems = [...bSet].filter(id => !aSet.has(id));
    const removedItems = [...aSet].filter(id => !bSet.has(id));
    const label = folderName || 'Root';
    if (newItems.length > 0) {
      hasContentDiff = true;
      details.push(`${label}: ${newItems.length} new item(s) from relay`);
    }
    if (removedItems.length > 0) {
      hasContentDiff = true;
      details.push(`${label}: ${removedItems.length} item(s) only in browser`);
    }
    const commonItems = aItems.filter(id => bSet.has(id));
    const bCommonItems = bItems.filter(id => aSet.has(id));
    if (
      commonItems.length > 1 &&
      commonItems.some((id, i) => id !== bCommonItems[i])
    ) {
      hasOrderDiff = true;
      details.push(`${label}: Item order differs`);
    }
  }
  for (const folderName of b.itemsByFolder.keys()) {
    if (
      !a.itemsByFolder.has(folderName) &&
      !newFromRelay.includes(folderName)
    ) {
      hasContentDiff = true;
      details.push(`Folder "${folderName}" only on relay`);
    }
  }

  // 4. Item properties
  for (const [itemId, aProps] of a.itemProperties) {
    const bProps = b.itemProperties.get(itemId);
    if (!bProps) continue; // item missing handled in set comparison
    if (aProps.isPrivate !== bProps.isPrivate) {
      hasContentDiff = true;
      details.push(`Item ${itemId.slice(0, 8)}: privacy setting differs`);
    }
    if (aProps.description !== bProps.description) {
      hasContentDiff = true;
      details.push(`Item ${itemId.slice(0, 8)}: description differs`);
    }
  }

  const hasDifference = hasContentDiff || hasOrderDiff;
  const isOrderOnly = !hasContentDiff && hasOrderDiff;
  const hasFolderSetDiff = onlyInBrowser.length > 0 || newFromRelay.length > 0;

  diagLog('lists', 'getBookmarkSnapshotDiffInfo', {
    hasDifference,
    isOrderOnly,
    hasFolderSetDiff,
    hasContentDiff,
    hasOrderDiff,
    details,
  });
  return { hasDifference, isOrderOnly, hasFolderSetDiff, details };
}

/**
 * Check if there's ANY difference between browser and relay/file data.
 * Returns true if merge modal should be shown.
 */
function hasAnyBookmarkDifference(
  sourceItems: BookmarkItem[],
  categories?: string[]
): boolean {
  const info = getBookmarkSnapshotDiffInfo(sourceItems, categories);
  return info.hasDifference;
}

// =============================================================================
// BOOKMARK STORAGE ADAPTER (for AutoSyncService / ListSyncManager)
// =============================================================================

/**
 * Storage adapter for bookmark lists
 */
export class BookmarkStorageAdapter {
  getBrowserItems(): BookmarkItem[] {
    return readBrowserBookmarks();
  }

  setBrowserItems(items: BookmarkItem[]): void {
    writeBrowserBookmarks(items);
    TypedEventBus.getInstance().emit('bookmark:updated');
  }

  getItemId(item: BookmarkItem): string {
    return item.id;
  }

  async getFileItems(): Promise<BookmarkItem[]> {
    return getAllBookmarksFromFile();
  }
  async setFileItems(_items: BookmarkItem[]): Promise<void> {
    await saveBookmarksToFile();
  }

  async restoreFolderDataFromFile(): Promise<void> {
    const folderData = await getAllFolderDataFromFile();
    const storage = (await import('./storage')).getStorage();
    if (folderData.folders.length > 0)
      storage.set(StorageKeys.BOOKMARK_FOLDERS, folderData.folders);
    if (folderData.folderAssignments.length > 0)
      storage.set(
        StorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS,
        folderData.folderAssignments
      );
    if (folderData.rootOrder.length > 0)
      storage.set(StorageKeys.BOOKMARK_ROOT_ORDER, folderData.rootOrder);
  }

  async fetchFromRelays(): Promise<FetchFromRelaysResult> {
    const pubkey = getCurrentUserPubkey();
    if (!pubkey) throw new Error('User not authenticated');
    return fetchBookmarksFromRelays(pubkey);
  }

  async publishToRelays(_items: BookmarkItem[]): Promise<void> {
    await publishBookmarksToRelays('adapter');
  }

  // Sync helper methods (for AutoSyncService)
  async syncFromRelays(): Promise<BookmarkAdapterSyncFromRelaysResult> {
    // Snapshot browser state BEFORE fetch (fetch takes 2-10s, user could change list meanwhile)
    const browserItems = this.getBrowserItems();
    diagLog('lists', 'syncFromRelays: browser items snapshot', {
      count: browserItems.length,
      ids: browserItems.map(i => i.id),
    });
    const fetchResult = await this.fetchFromRelays();
    diagLog('lists', 'syncFromRelays: fetch result', {
      itemCount: fetchResult.items.length,
      categories: fetchResult.categories,
      categoryAssignments: fetchResult.categoryAssignments
        ? Object.fromEntries(fetchResult.categoryAssignments)
        : undefined,
    });
    const diff = calculateBookmarkSyncDiff(browserItems, fetchResult.items);
    diagLog('lists', 'syncFromRelays: diff', {
      added: diff.added.map(i => i.id),
      removed: diff.removed.map(i => i.id),
      moved: diff.moved.map(m => ({
        id: m.browserItem.id,
        from: m.browserItem.category,
        to: m.sourceItem.category,
      })),
      unchangedCount: diff.unchanged.length,
    });

    const snapshotDiffInfo = getBookmarkSnapshotDiffInfo(
      fetchResult.items,
      fetchResult.categories
    );
    const requiresConfirmation = snapshotDiffInfo.hasDifference;
    diagLog('lists', 'syncFromRelays: requiresConfirmation', {
      requiresConfirmation,
      snapshotDiffInfo,
    });

    return {
      requiresConfirmation,
      snapshotDiffInfo,
      diff,
      relayItems: fetchResult.items,
      relayContentWasEmpty: fetchResult.relayContentWasEmpty,
      categoryAssignments: fetchResult.categoryAssignments,
      categories: fetchResult.categories,
      relayTimestamp: fetchResult.relayTimestamp,
      deletedCoordinates: fetchResult.deletedCoordinates,
    };
  }

  applySyncFromRelays(
    strategy: 'merge' | 'overwrite',
    relayItems: BookmarkItem[]
  ): void {
    if (strategy === 'overwrite') {
      this.setBrowserItems(relayItems);
    } else {
      this.setBrowserItems(
        mergeBookmarkItems(this.getBrowserItems(), relayItems)
      );
    }
  }
}

// =============================================================================
// UI COMPONENTS
// =============================================================================

// ----- BookmarkCard -----

export interface BookmarkCardData {
  id: string;
  type?: string;
  value?: string;
  event?: NostrEvent;
  isPrivate: boolean;
  folderId?: string;
  description?: string;
}

export interface BookmarkCardOptions {
  onDelete: (eventId: string) => Promise<void>;
  onEdit?: (bookmarkId: string) => void;
  onMove?: (bookmarkId: string, targetFolderId: string) => Promise<void>;
  moveTargets?: Array<{ id: string; label: string }>;
}

/**
 * BookmarkCard - Renders a single bookmark as a draggable card
 */
export class BookmarkCard {
  private data: BookmarkCardData;
  private options: BookmarkCardOptions;
  private element: HTMLElement | null = null;
  private userProfileService: UserProfileService;
  private router: Router;

  constructor(data: BookmarkCardData, options: BookmarkCardOptions) {
    this.data = data;
    this.options = options;
    this.userProfileService = UserProfileService.getInstance();
    this.router = Router.getInstance();
  }

  public async render(): Promise<HTMLElement> {
    const { id, event, isPrivate } = this.data;

    const card = document.createElement('div');
    card.className = 'nn-card';
    card.dataset.bookmark = '';
    card.dataset.eventId = id;
    card.dataset.bookmarkId = id;

    if (event) {
      const profile = await this.userProfileService.getUserProfile(
        event.pubkey
      );
      const username = profile?.name || 'Anonymous';
      const profilePic = profile?.picture || '';
      const snippet = this.getEventSnippet(event);
      const timeAgo = formatBookmarkTimestamp(event.created_at);

      card.innerHTML = `
        ${isPrivate ? '<span class="private-badge">🔒</span>' : ''}
        <div class="nn-card__content">
          <div class="author">
            ${
              profilePic
                ? `<img class="author-pic" src="${escapeHtmlAttr(profilePic)}" alt="" loading="lazy" />`
                : '<div class="author-pic"></div>'
            }
            <span class="author-name">${escapeHtml(username)}</span>
          </div>
          <div class="snippet">${escapeHtml(snippet)}</div>
          <div class="footer">
            <span class="timestamp">${timeAgo}</span>
            <div class="actions">
              <span class="move"></span>
              <button class="delete" aria-label="Remove bookmark" title="Remove bookmark">
                ${ICON_TRASH_16}
              </button>
            </div>
          </div>
        </div>
      `;
    } else {
      const { type, value, description } = this.data;
      let displayContent = '';
      let displayLabel = 'Unknown';
      let isContentHtml = false;
      const footerText = '—';

      if (type === 'r' && value) {
        displayLabel = 'URL';
        let displayUrl = '';
        try {
          const url = new URL(value);
          displayUrl =
            url.hostname +
            (url.pathname !== '/' ? url.pathname.slice(0, 30) : '');
        } catch {
          displayUrl = value.slice(0, 40);
        }
        displayContent = `<a href="${escapeHtmlAttr(value)}" class="external-link">${escapeHtml(displayUrl)}</a>`;
        if (description) {
          const descText =
            description.length > 60
              ? `${description.slice(0, 60)}...`
              : description;
          displayContent += `<span class="description">${escapeHtml(descText)}</span>`;
        }
        isContentHtml = true;
      } else if (type === 't' && value) {
        displayLabel = 'Hashtag';
        displayContent = `#${value}`;
      } else if (type === 'a' && value) {
        const isListing = value.startsWith('30402:');
        const isLiveStream = value.startsWith('30311:');
        displayLabel = isListing
          ? 'Listing'
          : isLiveStream
            ? 'Live Stream'
            : 'Address';
        if (description) {
          displayContent =
            description.length > 60
              ? `${description.slice(0, 60)}...`
              : description;
        } else {
          displayContent = `${value.slice(0, 40)}...`;
        }
      } else if ((type === 'e' || !type) && id) {
        // type='e' without a loaded event: don't cry "Note not found" — we may
        // simply not have fetched it yet. Show a neutral "Note" label and the
        // truncated id; the async load below replaces it with the real snippet
        // (title, content, picture, time) once the event resolves. The SNV
        // reverse-lookup does the same thing when the user clicks through.
        displayLabel = 'Note';
        displayContent = `${id.slice(0, 12)}…`;
      } else {
        displayLabel = 'Note not found';
        displayContent = `${id.slice(0, 8)}...`;
      }

      card.dataset.bookmarkType = type || 'e';
      const snippetMode = type === 'e' || !type ? 'not-found' : 'external';
      card.innerHTML = `
        ${isPrivate ? '<span class="private-badge">🔒</span>' : ''}
        <div class="nn-card__content">
          <div class="author">
            <div class="author-pic" data-pic-type="${type || 'e'}"></div>
            <span class="author-name">${escapeHtml(displayLabel)}</span>
          </div>
          <div class="snippet" data-snippet-mode="${snippetMode}">
            ${isContentHtml ? displayContent : escapeHtml(displayContent)}
          </div>
          <div class="footer">
            <span class="timestamp">${escapeHtml(footerText)}</span>
            <div class="actions">
              <span class="move"></span>
              ${
                type === 'r'
                  ? `
                <button class="btn btn--mini edit" aria-label="Edit bookmark" title="Edit bookmark">
                  Edit
                </button>
              `
                  : ''
              }
              <button class="delete" aria-label="Remove bookmark" title="Remove bookmark">
                ${ICON_TRASH_16}
              </button>
            </div>
          </div>
        </div>
      `;
    }

    this.bindEvents(card);
    this.element = card;

    // For type='e' bookmarks without a loaded event, try to resolve the event
    // asynchronously so the card can show the real author/title/snippet instead
    // of the neutral "Note" placeholder. Tries NoteService (LRU cache + relay
    // fetch by hex id) first, then falls back to the addressable reverse-lookup
    // for replaceable kinds (live streams, articles) whose original hex id is
    // no longer on any relay because the author published a newer version.
    // Read-only — never writes to localStorage; the lists-sync logic stays
    // untouched.
    if (
      !this.data.event &&
      (this.data.type === 'e' || !this.data.type) &&
      this.data.id
    ) {
      void this.loadEventForPlaceholder(card);
    }

    return card;
  }

  /**
   * Asynchronously load a type='e' bookmark's event and repaint the card so it
   * shows the real author / snippet / timestamp instead of the placeholder.
   * Swallows errors silently — the placeholder is already a graceful state.
   *
   * Read-only: mutates `this.data.event` (in-memory) and DOM only. Never
   * touches localStorage or the relays.
   */
  private async loadEventForPlaceholder(card: HTMLElement): Promise<void> {
    try {
      const id = this.data.id;
      if (!id) return;

      // Stage 1: NoteService (LRU cache + hex-id relay fetch)
      let event: NostrEvent | null =
        await NoteService.getInstance().getNote(id);

      // Stage 2: Reverse-lookup for replaceable kinds. If the hex id no longer
      // resolves (older version of a 30311/30023/... replaced by the author),
      // look for any repost referencing this id and extract the coordinate.
      if (!event) {
        const { resolveAddressableFromReferences } = await import(
          '../helpers/resolveAddressableFromReferences'
        );
        event = await resolveAddressableFromReferences(id);
      }

      if (!event) return;
      // Card may have been detached from the DOM (folder switch, view
      // teardown) by the time the fetch resolves.
      if (!card.isConnected) return;

      this.data.event = event;
      const profile = await this.userProfileService.getUserProfile(
        event.pubkey
      );
      const username = profile?.name || 'Anonymous';
      const profilePic = profile?.picture || '';
      const snippet = this.getEventSnippet(event);
      const timeAgo = formatBookmarkTimestamp(event.created_at);

      const authorNameEl = card.querySelector(
        '.author-name'
      ) as HTMLElement | null;
      const authorPicEl = card.querySelector(
        '.author-pic'
      ) as HTMLElement | null;
      const snippetEl = card.querySelector('.snippet') as HTMLElement | null;
      const timestampEl = card.querySelector(
        '.timestamp'
      ) as HTMLElement | null;

      if (authorNameEl) authorNameEl.textContent = username;
      if (snippetEl) {
        snippetEl.textContent = snippet;
        snippetEl.removeAttribute('data-snippet-mode');
      }
      // formatBookmarkTimestamp returns an HTML string (dual gregorian/hijri
      // span), so it must be innerHTML — textContent would render the tags
      // as literal text.
      if (timestampEl) timestampEl.innerHTML = timeAgo;
      if (authorPicEl) {
        authorPicEl.innerHTML = '';
        authorPicEl.removeAttribute('data-pic-type');
        if (profilePic) {
          const img = document.createElement('img');
          img.className = 'author-pic';
          img.src = profilePic;
          img.alt = '';
          img.loading = 'lazy';
          authorPicEl.replaceWith(img);
        }
      }
    } catch {
      // Leave the placeholder in place.
    }
  }

  private bindEvents(card: HTMLElement): void {
    const { id, event } = this.data;

    card.addEventListener('click', async e => {
      const target = e.target as HTMLElement;
      if (
        target.closest('.delete') ||
        target.closest('.edit') ||
        target.closest('.move')
      )
        return;

      if (card.dataset.wasDragging === 'true') {
        card.dataset.wasDragging = 'false';
        return;
      }

      const anchor = target.closest('a');
      if (anchor) {
        const href = anchor.getAttribute('href');
        if (
          href &&
          (href.startsWith('http://') || href.startsWith('https://'))
        ) {
          e.preventDefault();
          e.stopPropagation();
          if (PlatformService.getInstance().isElectron) {
            await window.electronAPI!.openExternal(href);
          } else {
            window.open(href, '_blank', 'noopener,noreferrer');
          }
          return;
        }
      }

      // Navigate to listing for 'a' tag bookmarks (kind:30402)
      if (this.data.type === 'a' && this.data.value?.startsWith('30402:')) {
        const parts = this.data.value.split(':');
        if (parts.length >= 3) {
          const { encodeNaddr } = await import('../services/NostrToolsAdapter');
          const naddr = encodeNaddr({
            kind: 30402,
            pubkey: parts[1]!,
            identifier: parts.slice(2).join(':'),
          });
          this.router.navigate(`/listing/${naddr}`);
        }
        return;
      }

      // Navigate to SNV for any other 'a' tag bookmark (e.g. kind:30311 live
      // stream). SNV's renderNote path routes addressable events through the
      // standard NoteProcessor → NoteRendererFactory pipeline, so a 30311
      // bookmark opens as a Live Stream card.
      if (this.data.type === 'a' && this.data.value) {
        const parts = this.data.value.split(':');
        if (parts.length >= 3) {
          const kindNum = Number(parts[0]);
          const pubkey = parts[1]!;
          const identifier = parts.slice(2).join(':');
          if (Number.isFinite(kindNum) && pubkey && identifier) {
            const { encodeNaddr } = await import(
              '../services/NostrToolsAdapter'
            );
            const naddr = encodeNaddr({ kind: kindNum, pubkey, identifier });
            this.router.navigate(`/note/${naddr}`);
          }
        }
        return;
      }

      // 'e' tag bookmark: prefer the loaded event id, fall back to the stored
      // value (hex event id) so the card is still clickable when the event
      // isn't in memory (e.g. older replaceable events whose original id is
      // no longer carried by any relay).
      const eventIdForNav = event?.id || this.data.value;
      if (eventIdForNav) {
        const nevent = encodeNevent(eventIdForNav);
        this.router.navigate(`/note/${nevent}`);
      }
    });

    const editBtn = card.querySelector('button.edit');
    editBtn?.addEventListener('click', e => {
      e.stopPropagation();
      this.options.onEdit?.(id);
    });

    const deleteBtn = card.querySelector('button.delete');
    deleteBtn?.addEventListener('click', async e => {
      e.stopPropagation();
      await this.options.onDelete(id);
      card.remove();
    });

    // Mount move dropdown (browser only)
    const moveMount = card.querySelector('.move');
    if (
      moveMount &&
      this.options.onMove &&
      this.options.moveTargets &&
      MoveDropdown.shouldShow()
    ) {
      const dropdown = new MoveDropdown({
        targets: this.options.moveTargets,
        ariaLabel: 'Move bookmark',
        onSelect: targetId => this.options.onMove!(id, targetId),
      });
      moveMount.appendChild(dropdown.getElement());
    }
  }

  private getTextSnippet(content: string, maxLength: number): string {
    const text = content
      .replace(
        /nostr:(note|nevent|npub|nprofile|naddr|nrelay)[a-zA-Z0-9]+/g,
        ''
      )
      .replace(/^>.*$/gm, '')
      .replace(/https?:\/\/[^\s]+/g, '')
      .trim();
    if (!text) return '(No text content)';
    return text.length > maxLength
      ? `${text.substring(0, maxLength)}...`
      : text;
  }

  /**
   * Kind-aware snippet. Addressable events (Follow Pack, Article, Zapstore App)
   * have empty content and carry their title/name in tags — plain text snippet
   * would show "(No text content)" for them.
   */
  private getEventSnippet(event: NostrEvent): string {
    if (event.kind === 39089) {
      const title =
        event.tags.find(t => t[0] === 'title')?.[1] ||
        event.tags.find(t => t[0] === 'n')?.[1] ||
        'Untitled';
      return `Follow Pack: ${title}`;
    }
    if (event.kind === 30023) {
      const title = event.tags.find(t => t[0] === 'title')?.[1] || 'Untitled';
      return `Article: ${title}`;
    }
    if (event.kind === 32267) {
      const name = event.tags.find(t => t[0] === 'name')?.[1] || 'App';
      return `App: ${name}`;
    }
    if (event.kind === 30030) {
      const title =
        event.tags.find(t => t[0] === 'title')?.[1] ||
        event.tags.find(t => t[0] === 'name')?.[1] ||
        'Untitled';
      return `Emoji Pack: ${title}`;
    }
    if (event.kind === 30311) {
      const title = event.tags.find(t => t[0] === 'title')?.[1] || 'Untitled';
      return `Live Stream: ${title}`;
    }
    if (event.kind === 30402) {
      const title =
        event.tags.find(t => t[0] === 'title')?.[1] || 'Untitled Listing';
      return `Listing: ${title}`;
    }
    if (event.kind === 20) {
      const s = this.getTextSnippet(event.content, 100);
      return s === '(No text content)' ? 'Picture' : s;
    }
    if (event.kind === 1068) {
      const question = (event.content || '').trim();
      const snippet =
        question.length > 80 ? `${question.slice(0, 80)}...` : question;
      return snippet ? `Poll: ${snippet}` : 'Poll';
    }
    if (event.kind === 9802) {
      const text = (event.content || '').trim();
      const snippet = text.length > 80 ? `${text.slice(0, 80)}...` : text;
      return snippet ? `Highlight: ${snippet}` : 'Highlight';
    }
    if (event.kind === 30617) {
      const name = event.tags.find(t => t[0] === 'name')?.[1] || 'Repo';
      return `Git Repository: ${name}`;
    }
    if (
      event.kind === 1617 ||
      event.kind === 1618 ||
      event.kind === 1619 ||
      event.kind === 1621
    ) {
      const subject = event.tags.find(t => t[0] === 'subject')?.[1];
      const label =
        event.kind === 1617
          ? 'Git Patch'
          : event.kind === 1621
            ? 'Git Issue'
            : 'Pull Request';
      return subject ? `${label}: ${subject}` : label;
    }
    if (
      event.kind === 1630 ||
      event.kind === 1631 ||
      event.kind === 1632 ||
      event.kind === 1633
    ) {
      const status =
        event.kind === 1630
          ? 'Open'
          : event.kind === 1631
            ? 'Applied/Merged'
            : event.kind === 1632
              ? 'Closed'
              : 'Draft';
      return `Git Status: ${status}`;
    }
    if (event.kind === 35129) {
      const title =
        event.tags.find(t => t[0] === 'title')?.[1] ||
        event.tags.find(t => t[0] === 'd')?.[1] ||
        'Untitled';
      return `Satellite Earth: ${title}`;
    }
    return this.getTextSnippet(event.content, 100);
  }

  public getElement(): HTMLElement | null {
    return this.element;
  }

  public getEventId(): string {
    return this.data.id;
  }
}

// ----- NewBookmarkModal -----

export interface NewBookmarkModalOptions {
  onConfirm: (
    url: string,
    description: string,
    folderId: string,
    newFolderName?: string
  ) => void;
}

/**
 * NewBookmarkModal - Modal to create a new URL bookmark
 */
export class NewBookmarkModal {
  private modalService: ModalService;
  private folderService: BookmarkFolderServiceImpl;
  private options: NewBookmarkModalOptions;

  constructor(options: NewBookmarkModalOptions) {
    this.modalService = ModalService.getInstance();
    this.folderService = getBookmarkFolderService();
    this.options = options;
  }

  public show(): void {
    const content = this.renderContent();

    this.modalService.show({
      title: 'New Bookmark',
      content,
      width: '450px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true,
    });

    setTimeout(() => {
      this.setupEventHandlers();
      const input = document.getElementById(
        'new-bookmark-url-input'
      ) as HTMLInputElement;
      input?.focus();
    }, 0);
  }

  private renderContent(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'new-bookmark-modal';

    const folders = this.folderService.getFolders();

    container.innerHTML = `
      <div class="new-bookmark-modal__content">
        <div class="form-group">
          <label for="new-bookmark-url-input">URL</label>
          <input
            type="url"
            id="new-bookmark-url-input"
            class="input"
            placeholder="https://..."
            autocomplete="off"
          />
        </div>

        <div class="form-group">
          <label for="new-bookmark-description-input">Description</label>
          <input
            type="text"
            id="new-bookmark-description-input"
            class="input"
            placeholder="Optional description..."
            maxlength="200"
            autocomplete="off"
          />
        </div>

        <div class="form-group">
          <label for="new-bookmark-folder-select">Save to</label>
          <select id="new-bookmark-folder-select" class="input">
            <option value="">Root Level</option>
            ${folders.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('')}
            <option value="__new__">+ Create new folder...</option>
          </select>
        </div>

        <div class="form-group new-bookmark-modal__new-folder-group" style="display: none;">
          <label for="new-bookmark-folder-name-input">New folder name</label>
          <input
            type="text"
            id="new-bookmark-folder-name-input"
            class="input"
            placeholder="Enter folder name..."
            maxlength="50"
            autocomplete="off"
          />
        </div>

        <div class="new-bookmark-modal__actions">
          <button type="button" class="btn btn--passive" id="new-bookmark-cancel-btn">
            Cancel
          </button>
          <button type="button" class="btn" id="new-bookmark-save-btn">
            Save
          </button>
        </div>
      </div>
    `;

    return container;
  }

  private setupEventHandlers(): void {
    const urlInput = document.getElementById(
      'new-bookmark-url-input'
    ) as HTMLInputElement;
    const descriptionInput = document.getElementById(
      'new-bookmark-description-input'
    ) as HTMLInputElement;
    const folderSelect = document.getElementById(
      'new-bookmark-folder-select'
    ) as HTMLSelectElement;
    const newFolderGroup = document.querySelector(
      '.new-bookmark-modal__new-folder-group'
    ) as HTMLElement;
    const newFolderInput = document.getElementById(
      'new-bookmark-folder-name-input'
    ) as HTMLInputElement;
    const cancelBtn = document.getElementById('new-bookmark-cancel-btn');
    const saveBtn = document.getElementById('new-bookmark-save-btn');

    if (!urlInput || !folderSelect || !cancelBtn || !saveBtn) return;

    folderSelect.addEventListener('change', () => {
      if (folderSelect.value === '__new__') {
        newFolderGroup.style.display = 'block';
        newFolderInput?.focus();
      } else {
        newFolderGroup.style.display = 'none';
      }
    });

    const handleSave = () => {
      const url = urlInput.value.trim();
      const description = descriptionInput?.value.trim() || '';

      if (!url) {
        urlInput.focus();
        return;
      }

      if (!isValidUrl(url)) {
        urlInput.setCustomValidity(
          'Please enter a valid URL starting with http:// or https://'
        );
        urlInput.reportValidity();
        return;
      }

      const folderId = folderSelect.value;
      const newFolderName =
        folderId === '__new__' ? newFolderInput?.value.trim() : undefined;

      if (folderId === '__new__' && !newFolderName) {
        newFolderInput?.focus();
        return;
      }

      this.modalService.hide();
      this.options.onConfirm(url, description, folderId, newFolderName);
    };

    cancelBtn.addEventListener('click', () => {
      this.modalService.hide();
    });
    saveBtn.addEventListener('click', handleSave);

    urlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') handleSave();
      else if (e.key === 'Escape') this.modalService.hide();
    });

    newFolderInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') handleSave();
      else if (e.key === 'Escape') this.modalService.hide();
    });
  }
}

// ----- EditBookmarkModal -----

export interface EditBookmarkModalOptions {
  url: string;
  description: string;
  onSave: (url: string, description: string) => void;
}

/**
 * EditBookmarkModal - Modal to edit an existing URL bookmark
 */
export class EditBookmarkModal {
  private modalService: ModalService;
  private options: EditBookmarkModalOptions;

  constructor(options: EditBookmarkModalOptions) {
    this.modalService = ModalService.getInstance();
    this.options = options;
  }

  public show(): void {
    const content = this.renderContent();

    this.modalService.show({
      title: 'Edit Bookmark',
      content,
      width: '450px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true,
    });

    setTimeout(() => {
      this.setupEventHandlers();
      const input = document.getElementById(
        'edit-bookmark-url-input'
      ) as HTMLInputElement;
      input?.focus();
      input?.select();
    }, 0);
  }

  private renderContent(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'edit-bookmark-modal';

    container.innerHTML = `
      <div class="edit-bookmark-modal__content">
        <div class="form-group">
          <label for="edit-bookmark-url-input">URL</label>
          <input
            type="url"
            id="edit-bookmark-url-input"
            class="input"
            placeholder="https://..."
            value="${escapeHtml(this.options.url)}"
            autocomplete="off"
          />
        </div>

        <div class="form-group">
          <label for="edit-bookmark-description-input">Description</label>
          <input
            type="text"
            id="edit-bookmark-description-input"
            class="input"
            placeholder="Optional description..."
            value="${escapeHtml(this.options.description)}"
            maxlength="200"
            autocomplete="off"
          />
        </div>

        <div class="edit-bookmark-modal__actions">
          <button type="button" class="btn btn--passive" id="edit-bookmark-cancel-btn">
            Cancel
          </button>
          <button type="button" class="btn" id="edit-bookmark-save-btn">
            Save
          </button>
        </div>
      </div>
    `;

    return container;
  }

  private setupEventHandlers(): void {
    const urlInput = document.getElementById(
      'edit-bookmark-url-input'
    ) as HTMLInputElement;
    const descriptionInput = document.getElementById(
      'edit-bookmark-description-input'
    ) as HTMLInputElement;
    const cancelBtn = document.getElementById('edit-bookmark-cancel-btn');
    const saveBtn = document.getElementById('edit-bookmark-save-btn');

    if (!urlInput || !cancelBtn || !saveBtn) return;

    const handleSave = () => {
      const url = urlInput.value.trim();
      const description = descriptionInput?.value.trim() || '';

      if (!url) {
        urlInput.focus();
        return;
      }

      if (!isValidUrl(url)) {
        urlInput.setCustomValidity(
          'Please enter a valid URL starting with http:// or https://'
        );
        urlInput.reportValidity();
        return;
      }

      this.modalService.hide();
      this.options.onSave(url, description);
    };

    cancelBtn.addEventListener('click', () => {
      this.modalService.hide();
    });
    saveBtn.addEventListener('click', handleSave);

    urlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') handleSave();
      else if (e.key === 'Escape') this.modalService.hide();
    });

    descriptionInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') handleSave();
      else if (e.key === 'Escape') this.modalService.hide();
    });
  }
}

// =============================================================================
// BOOKMARK MANAGER (UI Component)
// =============================================================================

interface BookmarkWithEvent extends BookmarkItem {
  event?: NostrEvent;
  isPrivate: boolean;
}

/**
 * Moved bookmark (different folder assignment)
 */
interface MovedBookmark {
  browserItem: BookmarkItem;
  sourceItem: BookmarkItem;
}

/**
 * Sync diff for bookmarks
 */
interface BookmarkSyncDiff {
  added: BookmarkItem[];
  removed: BookmarkItem[];
  unchanged: BookmarkItem[];
  moved: MovedBookmark[];
}

/**
 * Result from sync from relays
 */
interface BookmarkSyncFromRelaysResult {
  requiresConfirmation: boolean;
  diff: BookmarkSyncDiff;
  relayItems: BookmarkItem[];
  relayContentWasEmpty: boolean;
  categoryAssignments?: Map<string, string>;
  categories?: string[];
  relayTimestamp: number;
}

/**
 * Result from sync from file
 */
interface BookmarkSyncFromFileResult {
  requiresConfirmation: boolean;
  diff: BookmarkSyncDiff;
  fileItems: BookmarkItem[];
}

/**
 * BookmarkManager - Main UI component for bookmark grid view
 */
export class BookmarkManager {
  private containerElement: HTMLElement;
  private eventBus: TypedEventBus;
  private authService: AuthService;
  private folderService: BookmarkFolderServiceImpl;
  private noteService: NoteService;
  private adapter: BookmarkStorageAdapter;
  private profileMountsService: ProfileMountsService;
  private profileMountsOrch: ProfileMountsOrchestrator;

  // View state
  private currentFolderId: string = '';
  private bookmarksCache: Map<string, BookmarkWithEvent> = new Map();
  private isLoading: boolean = false;

  // Event handler for cleanup
  private closeDropdownHandler: ((e: Event) => void) | null = null;

  constructor(containerElement: HTMLElement) {
    this.containerElement = containerElement;
    this.eventBus = TypedEventBus.getInstance();
    this.authService = AuthService.getInstance();
    this.folderService = getBookmarkFolderService();
    this.noteService = NoteService.getInstance();
    this.adapter = new BookmarkStorageAdapter();
    this.profileMountsService = ProfileMountsService.getInstance();
    this.profileMountsOrch = ProfileMountsOrchestrator.getInstance();

    this.setupEventListeners();
  }

  // ===== Sync Helper Methods (inlined) =====

  private calculateDiff(
    browserItems: BookmarkItem[],
    sourceItems: BookmarkItem[]
  ): BookmarkSyncDiff {
    const browserMap = new Map(browserItems.map(item => [item.id, item]));
    const sourceMap = new Map(sourceItems.map(item => [item.id, item]));

    const added = sourceItems.filter(item => !browserMap.has(item.id));
    const removed = browserItems.filter(item => !sourceMap.has(item.id));

    // Items in both - check for category changes
    const unchanged: BookmarkItem[] = [];
    const moved: MovedBookmark[] = [];

    for (const browserItem of browserItems) {
      const sourceItem = sourceMap.get(browserItem.id);
      if (sourceItem) {
        const browserCategory = browserItem.category || '';
        const sourceCategory = sourceItem.category || '';
        if (browserCategory !== sourceCategory) {
          moved.push({ browserItem, sourceItem });
        } else {
          unchanged.push(browserItem);
        }
      }
    }

    return { added, removed, unchanged, moved };
  }

  private mergeItems(
    browserItems: BookmarkItem[],
    newItems: BookmarkItem[]
  ): BookmarkItem[] {
    return mergeByKey(browserItems, newItems, 'id');
  }

  private async syncFromRelays(): Promise<BookmarkSyncFromRelaysResult> {
    const fetchResult =
      (await this.adapter.fetchFromRelays()) as FetchFromRelaysResult;
    const browserItems = this.adapter.getBrowserItems();
    const diff = this.calculateDiff(browserItems, fetchResult.items);

    const result: BookmarkSyncFromRelaysResult = {
      requiresConfirmation: hasAnyBookmarkDifference(
        fetchResult.items,
        fetchResult.categories
      ),
      diff,
      relayItems: fetchResult.items,
      relayContentWasEmpty: fetchResult.relayContentWasEmpty,
      relayTimestamp: fetchResult.relayTimestamp,
    };
    if (fetchResult.categoryAssignments)
      result.categoryAssignments = fetchResult.categoryAssignments;
    if (fetchResult.categories) result.categories = fetchResult.categories;
    return result;
  }

  private async syncFromFile(): Promise<BookmarkSyncFromFileResult> {
    const fileItems = await this.adapter.getFileItems();
    const browserItems = this.adapter.getBrowserItems();
    const diff = this.calculateDiff(browserItems, fileItems);
    // Get categories from file for proper folder order comparison
    const fileData = await readBookmarkFile();
    const fileCategories = fileData.metadata.setOrder;
    return {
      requiresConfirmation: hasAnyBookmarkDifference(fileItems, fileCategories),
      diff,
      fileItems,
    };
  }

  private async syncToRelays(): Promise<void> {
    await this.adapter.publishToRelays(this.adapter.getBrowserItems());
  }

  private async saveToFile(): Promise<void> {
    await this.adapter.setFileItems(this.adapter.getBrowserItems());
  }

  private setupEventListeners(): void {
    this.eventBus.on('bookmark:updated', () => this.refreshIfActive());
    this.eventBus.on('list-sync-mode:changed', () => this.refreshIfActive());

    const resetState = (): void => {
      this.currentFolderId = '';
      this.bookmarksCache.clear();
    };
    this.eventBus.on('user:logout', resetState);
    this.eventBus.on('user:login', () => {
      resetState();
      this.refreshIfActive();
    });
  }

  private getBookmarksTabContainer(): HTMLElement | null {
    return this.containerElement.querySelector(
      '[data-tab-content="list-bookmarks"]'
    );
  }

  private refreshCurrentView(): void {
    const container = this.getBookmarksTabContainer();
    if (container) {
      this.renderCurrentView(container);
    }
  }

  private refreshIfActive(): void {
    const listTab = this.getBookmarksTabContainer();
    if (listTab?.classList.contains('tab-content--active')) {
      this.renderBookmarksTab(listTab);
    }
  }

  private applyRelayFolderAssignments(
    categoryAssignments: Map<string, string>,
    categories: string[],
    includeRootBookmarks: boolean
  ): void {
    const existingFolders = this.folderService.getFolders();

    // Create missing folders from relay — but never recreate a tombstoned folder
    // (the user deleted it). createFolder would also clear the tombstone, so skipping
    // here keeps the deletion intact. Items of such folders are routed to root below.
    for (const categoryName of categories) {
      if (
        categoryName !== '' &&
        !isBookmarkFolderTombstoned(categoryName) &&
        !existingFolders.find(f => f.name === categoryName)
      ) {
        this.folderService.createFolder(categoryName);
      }
    }

    const updatedFolders = this.folderService.getFolders();
    const currentRootOrder = this.folderService.getRootOrder();

    // Build new root order: relay folders first, then existing non-relay folders
    const newRootOrder: Array<{ type: 'folder' | 'bookmark'; id: string }> =
      categories
        .filter(c => c !== '')
        .map(categoryName => updatedFolders.find(f => f.name === categoryName))
        .filter((f): f is NonNullable<typeof f> => !!f)
        .map(f => ({ type: 'folder' as const, id: f.id }));

    const relayFolderIds = new Set(newRootOrder.map(item => item.id));
    newRootOrder.push(
      ...currentRootOrder.filter(
        item => item.type === 'folder' && !relayFolderIds.has(item.id)
      )
    );

    // Add bookmarks to root order
    if (includeRootBookmarks) {
      for (const [bookmarkId, categoryName] of categoryAssignments) {
        if (categoryName === '')
          newRootOrder.push({ type: 'bookmark', id: bookmarkId });
      }
    } else {
      newRootOrder.push(
        ...currentRootOrder.filter(item => item.type === 'bookmark')
      );
    }

    this.folderService.saveRootOrder(newRootOrder);

    // Apply folder assignments
    for (const [bookmarkId, categoryName] of categoryAssignments) {
      if (categoryName === '') {
        includeRootBookmarks
          ? this.folderService.moveBookmarkToFolder(bookmarkId, '')
          : this.folderService.ensureBookmarkAssignment(bookmarkId);
      } else if (isBookmarkFolderTombstoned(categoryName)) {
        // Tombstoned folder was not recreated — keep its items in root instead of losing them.
        this.folderService.moveBookmarkToFolder(bookmarkId, '');
      } else {
        const folder = updatedFolders.find(f => f.name === categoryName);
        if (folder)
          this.folderService.moveBookmarkToFolder(bookmarkId, folder.id);
      }
    }
  }

  public handleTabSwitch(tabName: string, content: HTMLElement): void {
    if (tabName === 'bookmarks') {
      this.renderBookmarksTab(content);
    }
  }

  public async renderListTab(container: HTMLElement): Promise<void> {
    await this.renderBookmarksTab(container);
  }

  private async renderBookmarksTab(container: HTMLElement): Promise<void> {
    const currentUser = this.authService.getCurrentUser();

    if (!currentUser) {
      container.innerHTML = `
        <div class="bookmarks-empty-state">
          <p>Log in to see your bookmarks</p>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="bookmarks-loading">Loading bookmarks...</div>
    `;

    try {
      await this.loadBookmarks();
      await this.renderCurrentView(container);
    } catch (error) {
      console.error('Failed to render bookmarks:', error);
      container.innerHTML = `
        <div class="bookmarks-empty-state">
          <p>Failed to load bookmarks</p>
        </div>
      `;
    }
  }

  private async loadBookmarks(): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;

    try {
      let bookmarks = this.adapter.getBrowserItems();

      // Cascade restore only in Easy Mode
      if (bookmarks.length === 0 && isEasyMode()) {
        // Try file first
        try {
          const fileItems = await this.adapter.getFileItems();
          if (fileItems.length > 0) {
            this.adapter.setBrowserItems(fileItems);
            bookmarks = fileItems;
            logger.info(
              'BookmarkManager',
              `Restored ${fileItems.length} bookmarks from file`
            );
          }
        } catch {
          // File read failed, continue to try relays
        }

        // If still empty, try relays
        if (bookmarks.length === 0) {
          try {
            const relayResult =
              (await this.adapter.fetchFromRelays()) as FetchFromRelaysResult;
            if (relayResult.items.length > 0) {
              this.adapter.setBrowserItems(relayResult.items);
              bookmarks = relayResult.items;
              logger.info(
                'BookmarkManager',
                `Restored ${relayResult.items.length} bookmarks from relays`
              );

              // Apply folder assignments from relay categories
              if (relayResult.categoryAssignments) {
                await applyFolderAssignments(
                  relayResult.categoryAssignments,
                  this.folderService,
                  (bookmarkId, folderId) =>
                    this.folderService.moveBookmarkToFolder(
                      bookmarkId,
                      folderId
                    ),
                  'BookmarkManager',
                  isBookmarkFolderTombstoned
                );
              }
            }
          } catch {
            // Relay fetch failed, continue with empty
          }
        }
      }

      if (bookmarks.length === 0) {
        this.bookmarksCache.clear();
        return;
      }

      const sortedBookmarks = [...bookmarks].sort((a, b) => {
        const timeA = a.addedAt || 0;
        const timeB = b.addedAt || 0;
        return timeB - timeA;
      });

      const eventBookmarks = sortedBookmarks.filter(b => b.type === 'e');
      const eventIds = eventBookmarks.map(b => b.id);
      const eventMap =
        eventIds.length > 0
          ? await this.noteService.getNotes(eventIds)
          : new Map<string, NostrEvent>();

      this.bookmarksCache.clear();

      const isFirstInit = !this.folderService.hasRootOrder();

      for (const bookmark of sortedBookmarks) {
        const event = eventMap.get(bookmark.id);
        const cacheEntry: BookmarkWithEvent = {
          id: bookmark.id,
          type: bookmark.type,
          value: bookmark.value,
          isPrivate:
            (bookmark as BookmarkItem & { isPrivate?: boolean }).isPrivate ||
            false,
        };
        if (bookmark.addedAt !== undefined)
          cacheEntry.addedAt = bookmark.addedAt;
        if (bookmark.category !== undefined)
          cacheEntry.category = bookmark.category;
        if (bookmark.description !== undefined)
          cacheEntry.description = bookmark.description;
        if (event) cacheEntry.event = event;
        this.bookmarksCache.set(bookmark.id, cacheEntry);

        this.folderService.ensureBookmarkAssignment(bookmark.id);
      }

      if (isFirstInit) {
        const rootOrder: Array<{ type: 'folder' | 'bookmark'; id: string }> =
          [];
        for (const bookmark of sortedBookmarks) {
          rootOrder.push({ type: 'bookmark', id: bookmark.id });
        }
        this.folderService.saveRootOrder(rootOrder);
      }
    } finally {
      this.isLoading = false;
    }
  }

  private async renderCurrentView(container: HTMLElement): Promise<void> {
    const isInFolder = this.currentFolderId !== '';
    const folder = isInFolder
      ? this.folderService.getFolder(this.currentFolderId)
      : null;

    container.innerHTML = `
      ${this.renderSyncControls()}
      ${this.renderHeader(folder)}
      ${isInFolder ? this.renderBreadcrumb(folder) : ''}
      <div class="grid-3-col"></div>
    `;

    this.bindSyncButtons(container);
    this.bindHeaderButtons(container);

    const grid = container.querySelector('.grid-3-col') as HTMLElement;
    await this.renderGridContent(grid);
  }

  private renderSyncControls(): string {
    return renderListSyncButtons();
  }

  private renderHeader(folder: { id: string; name: string } | null): string {
    const title = folder ? folder.name : 'Bookmarks';
    return renderListHeader(title, [
      {
        action: 'new-folder',
        icon: '<svg width="16" height="16"><use href="#icon-folder"/></svg>',
        label: 'Folder',
      },
      {
        action: 'new-bookmark',
        icon: '<svg width="16" height="16"><use href="#icon-bookmark-link"/></svg>',
        label: 'Bookmark',
      },
    ]);
  }

  private renderBreadcrumb(
    folder: { id: string; name: string } | null
  ): string {
    if (!folder) return '';
    return renderListBreadcrumb('Bookmarks', folder.name);
  }

  private async renderGridContent(grid: HTMLElement): Promise<void> {
    grid.innerHTML = '';

    if (this.currentFolderId !== '') {
      const upNav = new UpNavigator({
        onClick: () => this.navigateTo(''),
        onDrop: async bookmarkId => {
          await this.moveBookmarkToFolder(bookmarkId, '');
        },
      });
      grid.appendChild(upNav.render());

      const bookmarkIds = this.folderService.getBookmarksInFolder(
        this.currentFolderId
      );
      for (const bookmarkId of bookmarkIds) {
        const bookmark = this.bookmarksCache.get(bookmarkId);
        if (bookmark) {
          const card = await this.createBookmarkCard(bookmark);
          grid.appendChild(card);
        }
      }
    } else {
      const rootOrder = this.folderService.getRootOrder();
      const renderedIds = new Set<string>();

      for (const item of rootOrder) {
        if (item.type === 'folder') {
          const folder = this.folderService.getFolder(item.id);
          if (folder) {
            const card = this.createFolderCard(folder);
            grid.appendChild(card);
            renderedIds.add(item.id);
          }
        } else if (item.type === 'bookmark') {
          const bookmark = this.bookmarksCache.get(item.id);
          const folderId = this.folderService.getBookmarkFolder(item.id);
          if (bookmark && folderId === '') {
            const card = await this.createBookmarkCard(bookmark);
            grid.appendChild(card);
            renderedIds.add(item.id);
          }
        }
      }

      const folders = this.folderService.getFolders();
      for (const folder of folders) {
        if (!renderedIds.has(folder.id)) {
          const card = this.createFolderCard(folder);
          grid.appendChild(card);
          this.folderService.addToRootOrder('folder', folder.id);
        }
      }

      for (const [bookmarkId, bookmark] of this.bookmarksCache) {
        const folderId = this.folderService.getBookmarkFolder(bookmarkId);
        if (folderId === '' && !renderedIds.has(bookmarkId)) {
          const card = await this.createBookmarkCard(bookmark);
          grid.appendChild(card);
          this.folderService.addToRootOrder('bookmark', bookmarkId);
        }
      }
    }

    if (
      grid.children.length === 0 ||
      (this.currentFolderId === '' && grid.children.length === 0)
    ) {
      grid.innerHTML = `
        <div class="bookmarks-empty-state" style="grid-column: 1 / -1;">
          <p>No bookmarks yet</p>
        </div>
      `;
    }

    this.initGridDragDrop(grid);
  }

  private async createBookmarkCard(
    bookmark: BookmarkWithEvent
  ): Promise<HTMLElement> {
    const cardData: BookmarkCardData = {
      id: bookmark.id,
      type: bookmark.type,
      value: bookmark.value,
      isPrivate: bookmark.isPrivate,
      folderId: this.folderService.getBookmarkFolder(bookmark.id),
    };
    if (bookmark.event) cardData.event = bookmark.event;
    if (bookmark.description !== undefined)
      cardData.description = bookmark.description;

    // Build move targets: all folders (excluding current) + root if in a folder
    const currentFolderId = cardData.folderId || '';
    const allFolders = this.folderService.getFolders();
    const moveTargets: Array<{ id: string; label: string }> = [];
    if (currentFolderId !== '') {
      moveTargets.push({ id: '', label: 'Root' });
    }
    for (const f of allFolders) {
      if (f.id !== currentFolderId) {
        moveTargets.push({ id: f.id, label: f.name });
      }
    }

    const card = new BookmarkCard(cardData, {
      onDelete: async (eventId: string) => {
        await this.deleteBookmark(eventId);
      },
      onEdit: (bookmarkId: string) => {
        this.editBookmark(bookmarkId);
      },
      onMove: async (bookmarkId: string, targetFolderId: string) => {
        await this.moveBookmarkToFolder(bookmarkId, targetFolderId);
        this.refreshCurrentView();
      },
      moveTargets,
    });

    return card.render();
  }

  private getActualFolderItemCount(folderId: string): number {
    const realBookmarkIds = new Set(
      this.adapter.getBrowserItems().map(b => b.id)
    );
    const assignedIds = this.folderService.getBookmarksInFolder(folderId);
    return assignedIds.filter(id => realBookmarkIds.has(id)).length;
  }

  private createFolderCard(folder: { id: string; name: string }): HTMLElement {
    const currentUser = this.authService.getCurrentUser();
    const isLoggedIn = !!currentUser;

    const showProfileMountCheckbox = isLoggedIn;
    const folderData: FolderData = {
      id: folder.id,
      name: folder.name,
      itemCount: this.getActualFolderItemCount(folder.id),
      isMounted: isLoggedIn
        ? this.profileMountsService.isMounted(folder.name)
        : false,
    };

    const card = new FolderCard(folderData, {
      onClick: folderId => this.navigateTo(folderId),
      onEdit: folderId => this.editFolder(folderId),
      onDelete: async folderId => {
        await this.deleteFolder(folderId);
      },
      onDrop: async (bookmarkId, folderId) => {
        await this.moveBookmarkToFolder(bookmarkId, folderId);
      },
      onDragStart: _folderId => {},
      onDragEnd: () => {},
      showMountCheckbox: showProfileMountCheckbox,
      onMountToggle: (_folderId, folderName) =>
        this.handleMountToggle(folderName),
    });

    return card.render();
  }

  private async handleMountToggle(folderName: string): Promise<void> {
    const result = this.profileMountsService.toggleMount(folderName);

    if (result.error) {
      ToastService.show(result.error, 'error');
      const container = this.getBookmarksTabContainer();
      if (container) {
        this.renderCurrentView(container);
      }
      return;
    }

    if (result.mounted) {
      ToastService.show(`"${folderName}" mounted to profile`, 'success');
    } else {
      ToastService.show(`"${folderName}" unmounted from profile`, 'success');
    }

    this.profileMountsOrch.publishToRelays().catch(err => {
      console.error('Failed to publish profile mounts:', err);
    });
  }

  private initGridDragDrop(grid: HTMLElement): void {
    setupGridDragDrop(grid, {
      itemSelector: '[data-bookmark], [data-folder]',
      excludeSelector: 'button.delete',
      placeholderClass: 'bookmark-card-placeholder',
      getItemId: el => el.dataset.bookmarkId || el.dataset.folderId || null,
      onDrop: (draggedId, draggedEl, dropTarget) => {
        const targetId =
          dropTarget.dataset.bookmarkId || dropTarget.dataset.folderId;
        const isDraggingBookmark = draggedEl.dataset.bookmark !== undefined;
        const isDraggingFolder = draggedEl.dataset.folder !== undefined;
        const isTargetFolder = dropTarget.dataset.folder !== undefined;
        const isTargetUpNav = dropTarget.dataset.upNav !== undefined;

        if (isTargetUpNav && isDraggingBookmark) {
          this.moveBookmarkToFolder(draggedId, '');
        } else if (isTargetFolder && isDraggingBookmark && targetId) {
          this.moveBookmarkToFolder(draggedId, targetId);
        } else if (targetId && targetId !== draggedId) {
          if (this.currentFolderId && isDraggingBookmark) {
            const bookmarksInFolder = this.folderService.getBookmarksInFolder(
              this.currentFolderId
            );
            const targetIndex = bookmarksInFolder.findIndex(
              id => id === targetId
            );
            if (targetIndex !== -1) {
              this.folderService.moveItemToPosition(draggedId, targetIndex);
              grid.insertBefore(draggedEl, dropTarget);
              this.eventBus.emit('bookmark:order-changed');
            }
          } else {
            const draggedType = isDraggingFolder ? 'folder' : 'bookmark';
            const rootOrder = this.folderService.getRootOrder();
            const targetIndex = rootOrder.findIndex(
              item => item.id === targetId
            );
            if (targetIndex !== -1) {
              this.folderService.moveInRootOrder(
                draggedType as 'folder' | 'bookmark',
                draggedId,
                targetIndex
              );
              grid.insertBefore(draggedEl, dropTarget);
              this.eventBus.emit('bookmark:order-changed');
            }
          }
        }
      },
    });
  }

  private navigateTo(folderId: string): void {
    this.currentFolderId = folderId;
    const container = this.getBookmarksTabContainer();
    if (container) {
      this.renderCurrentView(container);
    }
  }

  private async deleteBookmark(eventId: string): Promise<void> {
    try {
      await removeBookmark(eventId);

      const currentItems = this.adapter.getBrowserItems();
      const updatedItems = currentItems.filter(b => b.id !== eventId);
      this.adapter.setBrowserItems(updatedItems);

      this.folderService.removeBookmarkAssignment(eventId);
      this.folderService.removeFromRootOrder('bookmark', eventId);

      this.bookmarksCache.delete(eventId);

      ToastService.show('Bookmark removed', 'success');

      // Reliable propagation: republish parent set IMMEDIATELY, bypassing the 2.5s debounce.
      // Per docs/features/lists.md "Reliable deletion publish" — every user-triggered delete
      // must reach relays without depending on debounce timing.
      diagLog('lists', 'immediate publish after deleteBookmark — start', {
        eventId,
      });
      try {
        await publishBookmarksToRelays('bookmark-delete-immediate');
        diagLog('lists', 'immediate publish after deleteBookmark — done', {
          eventId,
        });
      } catch (pubErr) {
        diagLog('lists', 'immediate publish after deleteBookmark — FAILED', {
          eventId,
          error: String(pubErr),
        });
        logger.warn(
          'bookmarks.ts',
          `Immediate publish after item delete failed: ${pubErr}`
        );
      }
    } catch (error) {
      console.error('Failed to delete bookmark:', error);
      ToastService.show('Failed to remove bookmark', 'error');
    }
  }

  private editBookmark(bookmarkId: string): void {
    const bookmark = this.bookmarksCache.get(bookmarkId);
    if (!bookmark || bookmark.type !== 'r') return;

    const modal = new EditBookmarkModal({
      url: bookmark.value || bookmark.id,
      description: bookmark.description || '',
      onSave: (newUrl, newDescription) => {
        try {
          const currentItems = this.adapter.getBrowserItems();
          const updatedItems: BookmarkItem[] = currentItems.map(item => {
            if (item.id === bookmarkId) {
              const updated: BookmarkItem = {
                ...item,
                id: newUrl,
                value: newUrl,
              };
              if (newDescription) {
                updated.description = newDescription;
              } else {
                delete updated.description;
              }
              return updated;
            }
            return item;
          });
          this.adapter.setBrowserItems(updatedItems);

          const cachedBookmark = this.bookmarksCache.get(bookmarkId);
          if (cachedBookmark) {
            this.bookmarksCache.delete(bookmarkId);
            const updatedCache: BookmarkWithEvent = {
              id: newUrl,
              type: cachedBookmark.type,
              value: newUrl,
              isPrivate: cachedBookmark.isPrivate,
            };
            if (cachedBookmark.addedAt !== undefined)
              updatedCache.addedAt = cachedBookmark.addedAt;
            if (cachedBookmark.category !== undefined)
              updatedCache.category = cachedBookmark.category;
            if (cachedBookmark.event) updatedCache.event = cachedBookmark.event;
            if (newDescription) updatedCache.description = newDescription;
            this.bookmarksCache.set(newUrl, updatedCache);
          }

          if (bookmarkId !== newUrl) {
            const folderId = this.folderService.getBookmarkFolder(bookmarkId);
            this.folderService.removeBookmarkAssignment(bookmarkId);
            if (folderId) {
              this.folderService.moveBookmarkToFolder(newUrl, folderId);
            } else {
              this.folderService.ensureBookmarkAssignment(newUrl);
              this.folderService.removeFromRootOrder('bookmark', bookmarkId);
              this.folderService.addToRootOrder('bookmark', newUrl);
            }
          }

          ToastService.show('Bookmark updated', 'success');
          this.refreshCurrentView();
        } catch (error) {
          console.error('Failed to update bookmark:', error);
          ToastService.show('Failed to update bookmark', 'error');
        }
      },
    });

    modal.show();
  }

  private editFolder(folderId: string): void {
    const folder = this.folderService.getFolder(folderId);
    if (!folder) return;

    const oldName = folder.name;

    const modal = new EditFolderModal({
      currentName: folder.name,
      onSave: async newName => {
        try {
          // Eager NIP-09 kind:5 deletion for the OLD folder coordinate, otherwise the
          // old kind:30003 set event keeps living on relays and resurrects on next fetch.
          // See docs/features/lists.md "Eager kind:5 deletion publish".
          if (oldName && oldName !== newName) {
            const currentUser = this.authService.getCurrentUser();
            if (currentUser) {
              const oldCoordinate = `30003:${currentUser.pubkey}:${oldName}`;
              diagLog(
                'lists',
                'eager kind:5 publish for folder rename — start',
                { oldName, newName, oldCoordinate }
              );
              try {
                const ok =
                  await DeletionService.getInstance().deleteByCoordinates(
                    [oldCoordinate],
                    `Bookmark folder renamed from "${oldName}" to "${newName}"`
                  );
                diagLog(
                  'lists',
                  'eager kind:5 publish for folder rename — done',
                  { oldName, newName, ok }
                );
              } catch (kind5Err) {
                diagLog(
                  'lists',
                  'eager kind:5 publish for folder rename — FAILED',
                  { oldName, newName, error: String(kind5Err) }
                );
                logger.warn(
                  'bookmarks.ts',
                  `Eager kind:5 publish failed for folder rename "${oldName}" → "${newName}": ${kind5Err}`
                );
              }
            }
          }

          // Tombstone the old folder name so the soon-to-be-orphaned kind:30003
          // event cannot resurrect under its old name; clear any tombstone on
          // the new name in case the user is reviving a previously deleted one.
          if (oldName && oldName !== newName) {
            addBookmarkFolderTombstone(oldName);
          }
          removeBookmarkFolderTombstone(newName);

          this.folderService.renameFolder(folderId, newName);

          this.profileMountsService.handleFolderRename(folder.name, newName);

          const currentItems = this.adapter.getBrowserItems();
          const updatedItems = currentItems.map(item => {
            if (item.category === folder.name) {
              return { ...item, category: newName };
            }
            return item;
          });
          this.adapter.setBrowserItems(updatedItems);

          for (const [_id, bookmark] of this.bookmarksCache) {
            if (bookmark.category === folder.name) {
              bookmark.category = newName;
            }
          }

          ToastService.show('Folder renamed', 'success');
          this.refreshCurrentView();
        } catch (error) {
          console.error('Failed to rename folder:', error);
          ToastService.show('Failed to rename folder', 'error');
        }
      },
    });

    modal.show();
  }

  private async deleteFolder(folderId: string): Promise<void> {
    try {
      const folder = this.folderService.getFolder(folderId);
      const folderName = folder?.name || '';

      // Eagerly publish NIP-09 kind:5 deletion BEFORE local mutation. This guarantees
      // that the relay network learns about the deletion regardless of whether a later
      // publishBookmarksToRelays would catch it via its conditional fetch-comparison.
      // See docs/features/lists.md "Eager kind:5 deletion publish".
      if (folderName) {
        const currentUser = this.authService.getCurrentUser();
        if (currentUser) {
          const coordinate = `30003:${currentUser.pubkey}:${folderName}`;
          diagLog('lists', 'eager kind:5 publish for folder delete — start', {
            folderName,
            coordinate,
          });
          try {
            const ok = await DeletionService.getInstance().deleteByCoordinates(
              [coordinate],
              `Bookmark folder "${folderName}" deleted`
            );
            diagLog('lists', 'eager kind:5 publish for folder delete — done', {
              folderName,
              ok,
            });
          } catch (kind5Err) {
            diagLog(
              'lists',
              'eager kind:5 publish for folder delete — FAILED',
              { folderName, error: String(kind5Err) }
            );
            logger.warn(
              'bookmarks.ts',
              `Eager kind:5 publish failed for folder "${folderName}": ${kind5Err}`
            );
          }
        }
      }

      this.profileMountsService.handleFolderDelete(folderName);

      // Record a client-side tombstone so this folder cannot resurrect on
      // this device, regardless of what relays still serve.
      addBookmarkFolderTombstone(folderName);

      const affectedIds = this.folderService.deleteFolder(folderId);

      this.folderService.removeFromRootOrder('folder', folderId);

      affectedIds.forEach(id => {
        this.folderService.addToRootOrder('bookmark', id);
      });

      const currentItems = this.adapter.getBrowserItems();
      const updatedItems = currentItems.map(item => {
        if (item.category === folderName) {
          return { ...item, category: '' };
        }
        return item;
      });
      this.adapter.setBrowserItems(updatedItems);

      for (const [_id, bookmark] of this.bookmarksCache) {
        if (bookmark.category === folderName) {
          bookmark.category = '';
        }
      }

      ToastService.show('Folder deleted, bookmarks moved to root', 'success');
      this.refreshCurrentView();
    } catch (error) {
      console.error('Failed to delete folder:', error);
      ToastService.show('Failed to delete folder', 'error');
    }
  }

  private async moveBookmarkToFolder(
    bookmarkId: string,
    targetFolderId: string
  ): Promise<void> {
    try {
      const currentFolderId = this.folderService.getBookmarkFolder(bookmarkId);

      if (currentFolderId === targetFolderId) return;

      const targetFolder = targetFolderId
        ? this.folderService.getFolder(targetFolderId)
        : null;
      const targetCategoryName = targetFolder?.name || '';

      this.folderService.moveBookmarkToFolder(bookmarkId, targetFolderId);

      if (currentFolderId === '' && targetFolderId !== '') {
        this.folderService.removeFromRootOrder('bookmark', bookmarkId);
      } else if (currentFolderId !== '' && targetFolderId === '') {
        this.folderService.addToRootOrder('bookmark', bookmarkId);
      }

      const currentItems = this.adapter.getBrowserItems();
      const updatedItems = currentItems.map(item => {
        if (item.id === bookmarkId) {
          return { ...item, category: targetCategoryName };
        }
        return item;
      });
      this.adapter.setBrowserItems(updatedItems);

      const cachedBookmark = this.bookmarksCache.get(bookmarkId);
      if (cachedBookmark) {
        cachedBookmark.category = targetCategoryName;
      }

      const targetName =
        targetFolderId === '' ? 'root' : targetFolder?.name || 'folder';
      ToastService.show(`Moved to ${targetName}`, 'success');

      this.eventBus.emit('bookmark:updated');

      const card = this.containerElement.querySelector(
        `[data-bookmark-id="${bookmarkId}"]`
      );
      card?.remove();

      if (targetFolderId !== '') {
        const folderCard = this.containerElement.querySelector(
          `[data-folder-id="${targetFolderId}"]`
        );
        const countEl = folderCard?.querySelector('.folder-card__count');
        if (countEl) {
          const newCount = this.getActualFolderItemCount(targetFolderId);
          countEl.textContent = `${newCount} ${newCount === 1 ? 'item' : 'items'}`;
        }
      }
    } catch (error) {
      console.error('Failed to move bookmark:', error);
      ToastService.show('Failed to move bookmark', 'error');
    }
  }

  private createNewFolder(): void {
    const modal = new NewFolderModal({
      onConfirm: name => {
        try {
          const folder = this.folderService.createFolder(name);
          this.folderService.addToRootOrder('folder', folder.id);

          const grid = this.containerElement.querySelector('.grid-3-col');
          if (grid) {
            const card = this.createFolderCard(folder);
            grid.insertBefore(card, grid.firstChild);
          }

          ToastService.show(`Folder "${name}" created`, 'success');

          this.eventBus.emit('bookmark:updated');
        } catch (error) {
          console.error('Failed to create folder:', error);
          ToastService.show('Failed to create folder', 'error');
        }
      },
    });

    modal.show();
  }

  private createNewBookmark(): void {
    const modal = new NewBookmarkModal({
      onConfirm: async (url, description, folderId, newFolderName) => {
        try {
          let targetFolderId = folderId;
          let categoryName = '';

          if (folderId === '__new__' && newFolderName) {
            const folder = this.folderService.createFolder(newFolderName);
            this.folderService.addToRootOrder('folder', folder.id);
            targetFolderId = folder.id;
            categoryName = newFolderName;
          } else if (folderId && folderId !== '') {
            const folder = this.folderService.getFolder(folderId);
            categoryName = folder?.name || '';
          }

          const bookmarkItem: BookmarkItem = {
            id: url,
            type: 'r',
            value: url,
            addedAt: now(),
            isPrivate: false,
            category: categoryName,
          };
          if (description) {
            bookmarkItem.description = description;
          }

          const currentItems = this.adapter.getBrowserItems();
          if (currentItems.some(b => b.id === url)) {
            ToastService.show('This URL is already bookmarked', 'info');
            return;
          }
          this.adapter.setBrowserItems([...currentItems, bookmarkItem]);

          const cacheEntry: BookmarkWithEvent = {
            id: url,
            type: 'r',
            value: url,
            isPrivate: false,
            category: categoryName,
          };
          if (bookmarkItem.addedAt !== undefined)
            cacheEntry.addedAt = bookmarkItem.addedAt;
          if (description) cacheEntry.description = description;
          this.bookmarksCache.set(url, cacheEntry);

          if (targetFolderId && targetFolderId !== '') {
            this.folderService.moveBookmarkToFolder(url, targetFolderId);
          } else {
            this.folderService.ensureBookmarkAssignment(url);
            this.folderService.addToRootOrder('bookmark', url);
          }

          ToastService.show('Bookmark created', 'success');

          this.eventBus.emit('bookmark:updated');

          this.refreshCurrentView();
        } catch (error) {
          console.error('Failed to create bookmark:', error);
          ToastService.show('Failed to create bookmark', 'error');
        }
      },
    });

    modal.show();
  }

  private bindSyncButtons(container: HTMLElement): void {
    bindListSyncButtons(container, {
      onSyncFromRelays: () => this.handleSyncFromRelays(container),
      onSyncToRelays: () => this.handleSyncToRelays(),
      onSaveToFile: () => this.handleSaveToFile(),
      onRestoreFromFile: () => this.handleRestoreFromFile(container),
      onSwitchMode: () => this.renderCurrentView(container),
    });
  }

  private bindHeaderButtons(container: HTMLElement): void {
    const closeRef = { current: this.closeDropdownHandler };
    bindHeaderDropdown(container, closeRef);
    this.closeDropdownHandler = closeRef.current;

    const dropdown = container.querySelector('[data-list-header-dropdown]');
    const folderItem = container.querySelector('[data-action="new-folder"]');
    const bookmarkItem = container.querySelector(
      '[data-action="new-bookmark"]'
    );

    folderItem?.addEventListener('click', () => {
      dropdown?.classList.remove('custom-dropdown--open');
      this.createNewFolder();
    });

    bookmarkItem?.addEventListener('click', () => {
      dropdown?.classList.remove('custom-dropdown--open');
      this.createNewBookmark();
    });

    const rootLink = container.querySelector('[data-navigate="root"]');
    rootLink?.addEventListener('click', () => this.navigateTo(''));
  }

  private async handleSyncFromRelays(container: HTMLElement): Promise<void> {
    try {
      ToastService.show('Fetching from relays...', 'info');

      const result = await this.syncFromRelays();

      // Full overwrite: replace bookmarks AND folder assignments from relay
      const fullOverwriteFromRelays = () => {
        this.adapter.setBrowserItems(result.relayItems);
        if (result.categoryAssignments) {
          this.applyRelayFolderAssignments(
            result.categoryAssignments,
            result.categories || [],
            true // Include root bookmarks - full replacement
          );
        }
      };

      // Merge: add new bookmarks with their folder assignments
      const mergeFromRelays = () => {
        const merged = this.mergeItems(
          this.adapter.getBrowserItems(),
          result.relayItems
        );
        this.adapter.setBrowserItems(merged);
        if (result.categoryAssignments) {
          this.applyRelayFolderAssignments(
            result.categoryAssignments,
            result.categories || [],
            false // Don't replace root bookmarks - merge only
          );
        }
      };

      if (result.requiresConfirmation) {
        // Convert moved items to MovedItemInfo format
        const movedItems: MovedItemInfo<BookmarkItem>[] = result.diff.moved.map(
          m => ({
            item: m.browserItem,
            browserFolder: m.browserItem.category || '',
            sourceFolder: m.sourceItem.category || '',
          })
        );

        const modal = new SyncConfirmationModal({
          listType: 'Bookmarks',
          added: result.diff.added,
          removed: result.diff.removed,
          moved: movedItems,
          getDisplayName: item => this.getDisplayNameForSync(item),
          onKeep: async () => {
            mergeFromRelays();
            await this.syncToRelays();
            ToastService.show(
              'Merged bookmarks and synced to relays',
              'success'
            );
            await this.loadBookmarks();
            this.renderCurrentView(container);
          },
          onRelay: async () => {
            fullOverwriteFromRelays();
            ToastService.show('Synced from relays', 'success');
            await this.loadBookmarks();
            this.renderCurrentView(container);
          },
          onLocal: async () => {
            await this.syncToRelays();
            ToastService.show('Local bookmarks pushed to relays', 'success');
            await this.loadBookmarks();
            this.renderCurrentView(container);
          },
        });

        await modal.show();
      } else {
        mergeFromRelays();
        ToastService.show('Synced from relays', 'success');
        await this.loadBookmarks();
        this.renderCurrentView(container);
      }
    } catch (error) {
      console.error('Failed to sync from relays:', error);
      ToastService.show('Failed to sync from relays', 'error');
    }
  }

  private async handleSyncToRelays(): Promise<void> {
    try {
      diagLog('lists', 'handleSyncToRelays: button pressed');
      ToastService.show('Publishing to relays...', 'info');
      await this.syncToRelays();
      diagLog('lists', 'handleSyncToRelays: success');
      ToastService.show('Bookmarks published successfully', 'success');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      diagLog('lists', 'handleSyncToRelays: FAILED', {
        error: msg,
        stack: error instanceof Error ? error.stack : undefined,
      });
      console.error('Failed to publish to relays:', error);
      ToastService.show('Failed to publish to relays', 'error');
    }
  }

  private async handleSaveToFile(): Promise<void> {
    try {
      ToastService.show('Saving...', 'info');
      if (PlatformService.getInstance().isDesktop) {
        await this.saveToFile();
      } else {
        downloadAsJson(this.adapter.getBrowserItems(), 'bookmarks');
      }
      ToastService.show('Saved successfully', 'success');
    } catch (error) {
      console.error('Failed to save to file:', error);
      ToastService.show('Failed to save to file', 'error');
    }
  }

  private async handleRestoreFromFile(container: HTMLElement): Promise<void> {
    try {
      let result: BookmarkSyncFromFileResult;
      const isBrowser = PlatformService.getInstance().isBrowser;

      if (isBrowser) {
        // Browser/Mobile: Upload file via dialog
        const uploadedItems = await uploadJsonFile<BookmarkItem[]>();
        if (!uploadedItems) {
          return; // User cancelled
        }
        const browserItems = this.adapter.getBrowserItems();
        const diff = this.calculateDiff(browserItems, uploadedItems);
        // For uploaded file, categories are derived from items (no setOrder available)
        result = {
          requiresConfirmation: hasAnyBookmarkDifference(uploadedItems),
          diff,
          fileItems: uploadedItems,
        };
      } else {
        // Desktop: Read from local file
        ToastService.show('Reading from file...', 'info');
        result = await this.syncFromFile();
      }

      // Full restore: sets bookmarks AND folder data from file (folder data only on Desktop)
      const fullRestoreFromFile = async () => {
        this.adapter.setBrowserItems(result.fileItems);
        if (!isBrowser) {
          const folderData = await getAllFolderDataFromFile();
          this.folderService.restoreAllFolderData(
            folderData.folders,
            folderData.folderAssignments,
            folderData.rootOrder
          );
        }
      };

      // Merge: add new bookmarks with their folder assignments
      const mergeFromFile = async (newItems: BookmarkItem[]) => {
        if (newItems.length === 0) return;
        const currentItems = this.adapter.getBrowserItems();
        const existingIds = new Set(currentItems.map(i => i.id));
        const itemsToAdd = newItems.filter(i => !existingIds.has(i.id));
        if (itemsToAdd.length === 0) return;

        this.adapter.setBrowserItems([...currentItems, ...itemsToAdd]);

        for (const item of itemsToAdd) {
          const categoryName = item.category || '';
          if (categoryName === '') {
            this.folderService.ensureBookmarkAssignment(item.id);
          } else {
            const folder = this.folderService
              .getFolders()
              .find(f => f.name === categoryName);
            if (folder) {
              this.folderService.moveBookmarkToFolder(item.id, folder.id);
            }
          }
        }
      };

      if (result.requiresConfirmation) {
        // Convert moved items to MovedItemInfo format
        const movedItems: MovedItemInfo<BookmarkItem>[] = result.diff.moved.map(
          m => ({
            item: m.browserItem,
            browserFolder: m.browserItem.category || '',
            sourceFolder: m.sourceItem.category || '',
          })
        );

        const modal = new SyncConfirmationModal({
          listType: 'Bookmarks (File)',
          added: result.diff.added,
          removed: result.diff.removed,
          moved: movedItems,
          getDisplayName: (item: BookmarkItem) =>
            this.getDisplayNameForSync(item),
          onKeep: async () => {
            await mergeFromFile(result.diff.added);
            await this.syncToRelays();
            ToastService.show(
              `Merged ${result.diff.added.length} from file and synced to relays`,
              'success'
            );
            await this.loadBookmarks();
            this.renderCurrentView(container);
          },
          onRelay: async () => {
            await fullRestoreFromFile();
            ToastService.show(
              `Restored from file (added ${result.diff.added.length}, removed ${result.diff.removed.length})`,
              'success'
            );
            await this.loadBookmarks();
            this.renderCurrentView(container);
          },
          onLocal: async () => {
            await this.syncToRelays();
            ToastService.show('Local bookmarks pushed to relays', 'success');
            await this.loadBookmarks();
            this.renderCurrentView(container);
          },
        });
        modal.show();
      } else if (result.diff.added.length > 0) {
        await fullRestoreFromFile();
        ToastService.show(
          `Restored ${result.diff.added.length} bookmark${result.diff.added.length > 1 ? 's' : ''} from file`,
          'success'
        );
        await this.loadBookmarks();
        this.renderCurrentView(container);
      } else {
        ToastService.show('File is identical to current list', 'info');
      }
    } catch (error) {
      console.error('Failed to restore from file:', error);
      ToastService.show(`Failed to restore from file: ${error}`, 'error');
    }
  }

  private async getDisplayNameForSync(item: BookmarkItem): Promise<string> {
    const fallback = `${item.id.slice(0, 12)}...`;
    const formatContent = (content?: string): string | null =>
      content ? content.slice(0, 60) || fallback : null;

    try {
      const cached = this.bookmarksCache.get(item.id);
      const cachedResult = formatContent(cached?.event?.content);
      if (cachedResult) return cachedResult;

      const cachedNote = this.noteService.getCachedNote(item.id);
      const cachedNoteResult = formatContent(cachedNote?.content);
      if (cachedNoteResult) return cachedNoteResult;

      const event = await this.noteService.getNote(item.id);
      return formatContent(event?.content) || fallback;
    } catch {
      return fallback;
    }
  }

  public destroy(): void {
    if (this.closeDropdownHandler) {
      document.removeEventListener('click', this.closeDropdownHandler);
      this.closeDropdownHandler = null;
    }
  }
}

// =============================================================================
// EXPORTS FOR BACKWARD COMPATIBILITY
// =============================================================================

// For components that import from old paths
export const BookmarkFolderService = {
  getInstance: getBookmarkFolderService,
};

// Legacy alias for BookmarkOrchestrator consumers
export const BookmarkOrchestrator = {
  getInstance: () => ({
    isPrivateBookmarksEnabled,
    setPrivateBookmarksEnabled,
    // Backward compatibility wrappers (extra params ignored)
    isBookmarked: (noteId: string, _pubkey?: string) =>
      isNoteBookmarked(noteId),
    addBookmark,
    removeBookmark: (noteId: string, _isPrivate?: boolean) =>
      removeBookmark(noteId),
    getAllBookmarks: getAllBookmarkIds,
    getAllBookmarksWithMetadata,
    getAllBookmarksWithStatus,
    saveToFile: saveBookmarksToFile,
    publishToRelays: publishBookmarksToRelays,
    fetchFromRelays: fetchBookmarksFromRelays,
    fetchBookmarksFromRelays,
    getBrowserItems: readBrowserBookmarks,
    setBrowserItems: writeBrowserBookmarks,
  }),
};
