/**
 * tribes.ts - All tribe logic in one file
 *
 * Tribes are NIP-51 Follow Sets (kind:30000) for grouping users.
 * Each tribe = one folder containing user pubkeys.
 *
 * Storage locations:
 * - localStorage (via PerAccountLocalStorage) - Single source of truth
 * - File (~/.noornote/{npub}/tribes.json) - Backup
 * - Relays (kind:30000 events) - Sync
 *
 * CRITICAL: Data formats must NOT change! This is refactoring, not redesign.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { StorageKeys, readList, writeList, deduplicateByPubkey, now } from './storage';
import { readJsonFile, writeJsonFile } from './file';
import {
  fetchEvents, publishEvent, signEvent,
  encryptContent, decryptContent,
  requireAuth, getCurrentUserPubkey
} from './relays';
import { PerAccountLocalStorage } from '../services/PerAccountLocalStorage';
import { SystemLogger } from '../components/system/SystemLogger';
import { EventBus } from '../services/EventBus';
import { DeletionService } from '../services/DeletionService';

const logger = SystemLogger.getInstance();
const eventBus = EventBus.getInstance();

// ============================================================
// TYPES (exact same format as before - DO NOT CHANGE!)
// ============================================================

/**
 * Tribe member stored in localStorage
 */
export interface TribeMember {
  id: string;          // pubkey or pubkey_category
  pubkey: string;
  relay?: string;
  addedAt?: number;
  isPrivate?: boolean;
  category?: string;   // tribe name (d-tag value, '' = root)
}

/**
 * Tribe folder (same as generic Folder)
 */
export interface TribeFolder {
  id: string;
  name: string;
  createdAt: number;
}

/**
 * Member-to-folder assignment
 */
export interface MemberAssignment {
  memberId: string;
  folderId: string;
  order: number;
}

/**
 * Root order item (mixed folders and members)
 */
export interface RootOrderItem {
  type: 'folder' | 'member';
  id: string;
}

/**
 * File storage format (TribeSetData)
 */
export interface TribeMemberTag {
  pubkey: string;
  relay?: string;
}

export interface TribeSet {
  kind: 30000;
  d: string;           // d-tag value (tribe name, '' = root)
  title: string;
  publicMembers: TribeMemberTag[];
  privateMembers: TribeMemberTag[];
}

export interface TribeSetData {
  version: 1;
  sets: TribeSet[];
  metadata: {
    setOrder: string[];
    lastModified: number;
  };
  lastModified: number;
}

/**
 * Result from fetching tribes from relays
 */
export interface FetchFromRelaysResult {
  items: TribeMember[];
  relayContentWasEmpty: boolean;
  categoryAssignments?: Map<string, string>; // pubkey -> tribeName
  categories?: string[]; // d-tags with "tribes/" prefix
}

// ============================================================
// BROWSER STORAGE (localStorage via PerAccountLocalStorage)
// ============================================================

const storage = PerAccountLocalStorage.getInstance();

// ----- Members -----

export function getMembers(): TribeMember[] {
  return readList<TribeMember>(StorageKeys.TRIBES, []);
}

export function setMembers(items: TribeMember[]): void {
  writeList(StorageKeys.TRIBES, deduplicateByPubkey(items));
  eventBus.emit('tribe:updated');
}

export function getMember(pubkey: string): TribeMember | undefined {
  return getMembers().find(m => m.pubkey === pubkey);
}

// ----- Folders -----

export function getFolders(): TribeFolder[] {
  return storage.get<TribeFolder[]>(StorageKeys.TRIBE_FOLDERS, []);
}

export function setFolders(folders: TribeFolder[]): void {
  storage.set(StorageKeys.TRIBE_FOLDERS, folders);
}

export function getFolder(folderId: string): TribeFolder | undefined {
  return getFolders().find(f => f.id === folderId);
}

export function getFolderByName(name: string): TribeFolder | undefined {
  return getFolders().find(f => f.name === name);
}

// ----- Assignments -----

export function getAssignments(): MemberAssignment[] {
  return storage.get<MemberAssignment[]>(StorageKeys.TRIBE_MEMBER_ASSIGNMENTS, []);
}

export function setAssignments(assignments: MemberAssignment[]): void {
  storage.set(StorageKeys.TRIBE_MEMBER_ASSIGNMENTS, assignments);
}

export function getMemberFolder(memberId: string): string {
  const assignment = getAssignments().find(a => a.memberId === memberId);
  return assignment?.folderId || '';
}

export function getMembersInFolder(folderId: string): string[] {
  return getAssignments()
    .filter(a => a.folderId === folderId)
    .sort((a, b) => a.order - b.order)
    .map(a => a.memberId);
}

export function getFolderItemCount(folderId: string): number {
  return getAssignments().filter(a => a.folderId === folderId).length;
}

// ----- Root Order -----

export function getRootOrder(): RootOrderItem[] {
  const order = storage.get<RootOrderItem[]>(StorageKeys.TRIBE_ROOT_ORDER, []);
  if (order.length === 0) {
    return buildInitialRootOrder();
  }
  return order;
}

export function setRootOrder(order: RootOrderItem[]): void {
  storage.set(StorageKeys.TRIBE_ROOT_ORDER, order);
}

export function hasRootOrder(): boolean {
  const order = storage.get<RootOrderItem[]>(StorageKeys.TRIBE_ROOT_ORDER, []);
  return order.length > 0;
}

export function clearRootOrder(): void {
  storage.remove(StorageKeys.TRIBE_ROOT_ORDER);
}

export function clearAssignments(): void {
  storage.remove(StorageKeys.TRIBE_MEMBER_ASSIGNMENTS);
}

function buildInitialRootOrder(): RootOrderItem[] {
  const folders = getFolders();
  const rootMemberIds = getMembersInFolder('');

  const order: RootOrderItem[] = [];

  // Add members (newest first)
  const reversedMemberIds = [...rootMemberIds].reverse();
  for (const id of reversedMemberIds) {
    order.push({ type: 'member', id });
  }

  // Add folders
  for (const folder of folders) {
    order.push({ type: 'folder', id: folder.id });
  }

  setRootOrder(order);
  return order;
}

// ============================================================
// FOLDER OPERATIONS
// ============================================================

export function createFolder(name: string): TribeFolder {
  const folders = getFolders();
  const id = `folder_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const folder: TribeFolder = { id, name, createdAt: now() };

  folders.push(folder);
  setFolders(folders);

  // Add to root order
  addToRootOrder('folder', id);

  logger.info('tribes.ts', `Created folder: ${name}`);
  return folder;
}

export function renameFolder(folderId: string, newName: string): void {
  const folders = getFolders();
  const folder = folders.find(f => f.id === folderId);
  if (folder) {
    folder.name = newName;
    setFolders(folders);
    logger.info('tribes.ts', `Renamed folder to: ${newName}`);
  }
}

/**
 * Delete folder and all members in it
 * (Tribes behavior: members are deleted with the tribe, not moved to root)
 */
export function deleteFolder(folderId: string): string[] {
  const memberIds = getMembersInFolder(folderId);

  // Remove assignments for this folder
  const assignments = getAssignments().filter(a => a.folderId !== folderId);
  setAssignments(assignments);

  // Remove folder
  const folders = getFolders().filter(f => f.id !== folderId);
  setFolders(folders);

  // Remove from root order
  removeFromRootOrder('folder', folderId);
  for (const memberId of memberIds) {
    removeFromRootOrder('member', memberId);
  }

  logger.info('tribes.ts', `Deleted folder with ${memberIds.length} members`);
  return memberIds;
}

// ============================================================
// MEMBER OPERATIONS
// ============================================================

export function addMember(
  pubkey: string,
  isPrivate: boolean,
  category: string = '',
  folderId?: string
): boolean {
  requireAuth();

  const members = getMembers();

  // Check if already in this specific tribe
  if (members.some(m => m.pubkey === pubkey && m.category === category)) {
    return true; // Already exists
  }

  // Check if private tribes feature is enabled
  const canBePrivate = isPrivate && isPrivateTribesEnabled();

  // Create unique ID: pubkey + category
  const uniqueId = category ? `${pubkey}_${category}` : pubkey;

  const member: TribeMember = {
    id: uniqueId,
    pubkey,
    relay: '',
    addedAt: now(),
    isPrivate: canBePrivate,
    category
  };

  members.push(member);
  setMembers(members);

  // Create folder assignment
  const targetFolderId = folderId || category;
  ensureMemberAssignment(uniqueId);

  if (targetFolderId !== '') {
    moveMemberToFolder(uniqueId, targetFolderId);
  }

  logger.info('tribes.ts', `Added ${canBePrivate ? 'private' : 'public'} member: ${pubkey.slice(0, 8)}...`);
  return true;
}

export function removeMember(pubkey: string): boolean {
  requireAuth();

  const members = getMembers();

  // Find all items with this pubkey
  const itemsToRemove = members.filter(m => m.pubkey === pubkey);

  // Remove from browser storage
  const updatedMembers = members.filter(m => m.pubkey !== pubkey);
  setMembers(updatedMembers);

  // Remove folder assignments
  for (const item of itemsToRemove) {
    removeMemberAssignment(item.id);
  }

  // Also remove by pubkey prefix (catches orphaned assignments)
  removeMemberAssignmentsByPubkey(pubkey);

  logger.info('tribes.ts', `Removed member: ${pubkey.slice(0, 8)}...`);
  return true;
}

// ============================================================
// ASSIGNMENT OPERATIONS
// ============================================================

export function ensureMemberAssignment(memberId: string, explicitOrder?: number): void {
  const assignments = getAssignments();
  const existing = assignments.find(a => a.memberId === memberId);

  if (!existing) {
    const order = explicitOrder !== undefined
      ? explicitOrder
      : assignments.filter(a => a.folderId === '').reduce((max, a) => Math.max(max, a.order), -1) + 1;

    assignments.push({ memberId, folderId: '', order });
    setAssignments(assignments);
  }
}

export function removeMemberAssignment(memberId: string): void {
  const assignments = getAssignments().filter(a => a.memberId !== memberId);
  setAssignments(assignments);
}

export function removeMemberAssignmentsByPubkey(pubkey: string): void {
  const assignments = getAssignments().filter(a => !a.memberId.startsWith(pubkey));
  setAssignments(assignments);
}

export function moveMemberToFolder(memberId: string, targetFolderId: string, explicitOrder?: number): void {
  const assignments = getAssignments();
  const existing = assignments.find(a => a.memberId === memberId);

  if (existing) {
    const oldFolderId = existing.folderId;
    existing.folderId = targetFolderId;

    if (explicitOrder !== undefined) {
      existing.order = explicitOrder;
    } else {
      const maxOrder = assignments
        .filter(a => a.folderId === targetFolderId && a.memberId !== memberId)
        .reduce((max, a) => Math.max(max, a.order), -1);
      existing.order = maxOrder + 1;
    }

    setAssignments(assignments);
    reorderItemsInFolder(oldFolderId);
  } else {
    const order = explicitOrder !== undefined
      ? explicitOrder
      : assignments.filter(a => a.folderId === targetFolderId).reduce((max, a) => Math.max(max, a.order), -1) + 1;

    assignments.push({ memberId, folderId: targetFolderId, order });
    setAssignments(assignments);
  }
}

export function moveItemToPosition(memberId: string, newOrder: number): void {
  const assignments = getAssignments();
  const item = assignments.find(a => a.memberId === memberId);
  if (!item) return;

  const folderId = item.folderId;
  const itemsInFolder = assignments
    .filter(a => a.folderId === folderId)
    .sort((a, b) => a.order - b.order);

  const currentIndex = itemsInFolder.findIndex(a => a.memberId === memberId);
  if (currentIndex === -1) return;

  itemsInFolder.splice(currentIndex, 1);
  const insertIndex = Math.min(newOrder, itemsInFolder.length);
  itemsInFolder.splice(insertIndex, 0, item);

  itemsInFolder.forEach((a, index) => { a.order = index; });
  setAssignments(assignments);
}

function reorderItemsInFolder(folderId: string): void {
  const assignments = getAssignments();
  const itemsInFolder = assignments
    .filter(a => a.folderId === folderId)
    .sort((a, b) => a.order - b.order);

  itemsInFolder.forEach((item, index) => { item.order = index; });
  setAssignments(assignments);
}

// ============================================================
// ROOT ORDER OPERATIONS
// ============================================================

export function addToRootOrder(type: 'folder' | 'member', id: string): void {
  const order = getRootOrder();
  if (!order.some(item => item.type === type && item.id === id)) {
    order.unshift({ type, id }); // Add at beginning
    setRootOrder(order);
  }
}

export function removeFromRootOrder(type: 'folder' | 'member', id: string): void {
  const order = getRootOrder().filter(item => !(item.type === type && item.id === id));
  setRootOrder(order);
}

export function moveInRootOrder(type: 'folder' | 'member', id: string, newIndex: number): void {
  const order = getRootOrder();
  const currentIndex = order.findIndex(item => item.type === type && item.id === id);
  if (currentIndex === -1) return;

  const [item] = order.splice(currentIndex, 1);
  if (!item) return;

  const insertIndex = Math.min(newIndex, order.length);
  order.splice(insertIndex, 0, item);
  setRootOrder(order);
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

/**
 * Extract pubkey from member ID (handles "pubkey" or "pubkey_category" format)
 */
export function extractPubkeyFromMemberId(memberId: string): string {
  const underscoreIndex = memberId.indexOf('_');
  if (underscoreIndex === 64) {
    return memberId.substring(0, 64);
  }
  return memberId;
}

/**
 * Get member pubkeys in a folder (extracts pure pubkeys)
 */
export function getMemberPubkeysInFolder(folderId: string): string[] {
  const memberIds = getMembersInFolder(folderId);
  return memberIds.map(extractPubkeyFromMemberId);
}

/**
 * Get folders sorted by root order
 */
export function getFoldersInRootOrder(): TribeFolder[] {
  const allFolders = getFolders();
  const rootOrder = getRootOrder();

  const folderOrder = rootOrder
    .filter(item => item.type === 'folder')
    .map(item => item.id);

  return folderOrder
    .map(id => allFolders.find(f => f.id === id))
    .filter((f): f is TribeFolder => f !== undefined);
}

/**
 * Check if private tribes feature is enabled
 */
export function isPrivateTribesEnabled(): boolean {
  try {
    return localStorage.getItem('noornote_nip51_private_tribes_enabled') === 'true';
  } catch {
    return false;
  }
}

/**
 * Set private tribes feature flag
 */
export function setPrivateTribesEnabled(enabled: boolean): void {
  localStorage.setItem('noornote_nip51_private_tribes_enabled', enabled.toString());
}

// ============================================================
// FILE STORAGE (Tauri)
// ============================================================

const TRIBES_FILE = 'tribes.json';

function createEmptyTribeSetData(): TribeSetData {
  const timestamp = now();
  return {
    version: 1,
    sets: [{
      kind: 30000,
      d: '',
      title: '',
      publicMembers: [],
      privateMembers: []
    }],
    metadata: {
      setOrder: [''],
      lastModified: timestamp
    },
    lastModified: timestamp
  };
}

export async function readFromFile(): Promise<TribeSetData> {
  return await readJsonFile<TribeSetData>(TRIBES_FILE, createEmptyTribeSetData());
}

export async function writeToFile(data: TribeSetData): Promise<void> {
  data.lastModified = now();
  data.metadata.lastModified = now();
  await writeJsonFile(TRIBES_FILE, data);
}

/**
 * Save current browser state to file
 */
export async function saveToFile(): Promise<void> {
  const setData = buildSetDataFromBrowser();
  await writeToFile(setData);
  logger.info('tribes.ts', `Saved to file: ${setData.sets.length} sets`);
}

/**
 * Restore from file to browser storage
 */
export async function restoreFromFile(): Promise<void> {
  const data = await readFromFile();
  const { members, folders, assignments, rootOrder } = extractFromSetData(data);

  setMembers(members);
  setFolders(folders);
  setAssignments(assignments);
  setRootOrder(rootOrder);

  logger.info('tribes.ts', `Restored from file: ${members.length} members`);
}

/**
 * Get all members from file (for RestoreListsService)
 */
export async function getFileMembers(): Promise<TribeMember[]> {
  const data = await readFromFile();
  const { members } = extractFromSetData(data);
  return members;
}

/**
 * Apply relay fetch result to browser storage
 * Creates folders and assignments based on member categories
 */
export function applyRelayFetchResult(
  members: TribeMember[],
  _categoryAssignments?: Map<string, string>,
  categories?: string[]
): void {
  // Build folders from categories (skip empty/root category)
  const newFolders: TribeFolder[] = [];
  const folderNameToId = new Map<string, string>();

  if (categories) {
    for (const dTag of categories) {
      // Skip root category (tribes/ or empty)
      if (dTag === 'tribes/' || dTag === '') continue;

      // Extract tribe name from d-tag (remove "tribes/" prefix if present)
      const tribeName = dTag.startsWith('tribes/') ? dTag.substring(7) : dTag;
      if (!tribeName) continue;

      // Create folder
      const folderId = `folder_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      newFolders.push({
        id: folderId,
        name: tribeName,
        createdAt: now()
      });
      folderNameToId.set(tribeName, folderId);
    }
  }

  // Build assignments from member categories
  const newAssignments: MemberAssignment[] = [];
  const newRootOrder: RootOrderItem[] = [];

  // Add folders to root order first
  for (const folder of newFolders) {
    newRootOrder.push({ type: 'folder', id: folder.id });
  }

  // Assign members to their folders
  for (const member of members) {
    const tribeName = member.category || '';
    const folderId = folderNameToId.get(tribeName);

    if (folderId) {
      // Member belongs to a folder
      newAssignments.push({
        memberId: member.id,
        folderId: folderId,
        order: newAssignments.filter(a => a.folderId === folderId).length
      });
    }
    // Note: In Tribes, members without a folder assignment are NOT added to root
    // (unlike Bookmarks where items can exist in root)
  }

  // Set all data
  setMembers(members);
  setFolders(newFolders);
  setAssignments(newAssignments);
  setRootOrder(newRootOrder);

  logger.info('tribes.ts', `Applied relay result: ${members.length} members, ${newFolders.length} folders`);
  // Note: Caller is responsible for emitting tribe:updated if needed
}

/**
 * Build TribeSetData from current browser state
 */
function buildSetDataFromBrowser(): TribeSetData {
  const allMembers = getMembers();
  const folders = getFolders();

  // Build item lookup map
  const itemMap = new Map<string, TribeMember>();
  for (const item of allMembers) {
    itemMap.set(item.id, item);
  }

  // Create sets map
  const setsMap = new Map<string, TribeSet>();

  // Initialize root set
  setsMap.set('', {
    kind: 30000,
    d: '',
    title: '',
    publicMembers: [],
    privateMembers: []
  });

  // Create sets for each folder
  for (const folder of folders) {
    setsMap.set(folder.name, {
      kind: 30000,
      d: folder.name,
      title: folder.name,
      publicMembers: [],
      privateMembers: []
    });
  }

  // Track assigned items
  const assignedIds = new Set<string>();

  // Helper to add member to set
  const addMemberToSet = (set: TribeSet, item: TribeMember): void => {
    const tag: TribeMemberTag = { pubkey: item.pubkey };
    if (item.relay) tag.relay = item.relay;

    if (item.isPrivate) {
      set.privateMembers.push(tag);
    } else {
      set.publicMembers.push(tag);
    }
  };

  // Process folders in order
  for (const folder of folders) {
    const set = setsMap.get(folder.name)!;
    const memberIds = getMembersInFolder(folder.id);

    for (const memberId of memberIds) {
      const item = itemMap.get(memberId);
      if (item) {
        addMemberToSet(set, item);
        assignedIds.add(memberId);
      }
    }
  }

  // Process root items
  const rootSet = setsMap.get('')!;
  const rootMemberIds = getMembersInFolder('');

  for (const memberId of rootMemberIds) {
    const item = itemMap.get(memberId);
    if (item) {
      addMemberToSet(rootSet, item);
      assignedIds.add(memberId);
    }
  }

  // Handle orphaned items (add to root)
  for (const item of allMembers) {
    if (!assignedIds.has(item.id)) {
      addMemberToSet(rootSet, item);
      ensureMemberAssignment(item.id);
    }
  }

  // Build setOrder from rootOrder (respects user's custom folder order)
  const rootOrder = getRootOrder();
  const orderedFolderNames = rootOrder
    .filter(item => item.type === 'folder')
    .map(item => {
      const folder = folders.find(f => f.id === item.id);
      return folder?.name;
    })
    .filter((name): name is string => !!name);

  // Add any folders not in rootOrder (shouldn't happen, but be safe)
  for (const folder of folders) {
    if (!orderedFolderNames.includes(folder.name)) {
      orderedFolderNames.push(folder.name);
    }
  }

  const setOrder = ['', ...orderedFolderNames];

  return {
    version: 1,
    sets: Array.from(setsMap.values()),
    metadata: {
      setOrder,
      lastModified: now()
    },
    lastModified: now()
  };
}

/**
 * Extract browser data from TribeSetData
 */
function extractFromSetData(data: TribeSetData): {
  members: TribeMember[];
  folders: TribeFolder[];
  assignments: MemberAssignment[];
  rootOrder: RootOrderItem[];
} {
  const members: TribeMember[] = [];
  const folders: TribeFolder[] = [];
  const assignments: MemberAssignment[] = [];
  const rootOrder: RootOrderItem[] = [];

  const timestamp = data.metadata?.lastModified || data.lastModified || now();

  for (const set of data.sets) {
    const category = set.d;

    // Create folder for non-root sets
    if (category !== '') {
      const folderId = `folder_${category}`;
      folders.push({ id: folderId, name: category, createdAt: timestamp });
      rootOrder.push({ type: 'folder', id: folderId });
    }

    let itemOrder = 0;
    const folderId = category === '' ? '' : `folder_${category}`;

    // Process public members
    for (const tag of set.publicMembers) {
      const uniqueId = category ? `${tag.pubkey}_${category}` : tag.pubkey;
      const member: TribeMember = {
        id: uniqueId,
        pubkey: tag.pubkey,
        addedAt: timestamp,
        isPrivate: false,
        category
      };
      if (tag.relay) member.relay = tag.relay;
      members.push(member);

      assignments.push({ memberId: uniqueId, folderId, order: itemOrder++ });
      if (category === '') {
        rootOrder.push({ type: 'member', id: uniqueId });
      }
    }

    // Process private members
    for (const tag of set.privateMembers) {
      const uniqueId = category ? `${tag.pubkey}_${category}` : tag.pubkey;
      const member: TribeMember = {
        id: uniqueId,
        pubkey: tag.pubkey,
        addedAt: timestamp,
        isPrivate: true,
        category
      };
      if (tag.relay) member.relay = tag.relay;
      members.push(member);

      assignments.push({ memberId: uniqueId, folderId, order: itemOrder++ });
      if (category === '') {
        rootOrder.push({ type: 'member', id: uniqueId });
      }
    }
  }

  return { members, folders, assignments, rootOrder };
}

// ============================================================
// RELAY OPERATIONS
// ============================================================

/**
 * Fetch tribes from relays
 */
export async function fetchFromRelays(): Promise<FetchFromRelaysResult> {
  const pubkey = getCurrentUserPubkey();
  if (!pubkey) {
    return { items: [], relayContentWasEmpty: true };
  }

  try {
    // Fetch all kind:30000 events
    const events = await fetchEvents([{
      authors: [pubkey],
      kinds: [30000],
      limit: 100
    }], 10000);

    // Fetch deletion events (kind:5)
    const deletionEvents = await fetchEvents([{
      authors: [pubkey],
      kinds: [5]
    }], 5000);

    // Extract deleted coordinates with timestamps
    const deletedCoordinates = new Map<string, number>();
    for (const delEvent of deletionEvents) {
      for (const tag of delEvent.tags) {
        if (tag[0] === 'a' && tag[1]?.startsWith('30000:')) {
          const coord = tag[1];
          const existing = deletedCoordinates.get(coord);
          if (!existing || delEvent.created_at > existing) {
            deletedCoordinates.set(coord, delEvent.created_at);
          }
        }
      }
    }

    if (events.length === 0 && deletedCoordinates.size === 0) {
      logger.info('tribes.ts', 'No tribe sets found on relays');
      return { items: [], relayContentWasEmpty: true };
    }

    // Deduplicate by d-tag (keep newest per tribe)
    const eventsByDTag = new Map<string, NostrEvent>();

    for (const event of events) {
      const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';

      // Only process events with "tribes/" prefix
      if (!dTag.startsWith('tribes/')) continue;

      // Check if deleted
      const coordinate = `30000:${pubkey}:${dTag}`;
      const deletionTimestamp = deletedCoordinates.get(coordinate);
      if (deletionTimestamp !== undefined && event.created_at < deletionTimestamp) {
        continue;
      }

      const existing = eventsByDTag.get(dTag);
      if (!existing || event.created_at > existing.created_at) {
        eventsByDTag.set(dTag, event);
      }
    }

    if (eventsByDTag.size === 0) {
      logger.info('tribes.ts', 'No tribe sets after filtering');
      return { items: [], relayContentWasEmpty: true };
    }

    // Fetch folder order metadata (NIP-78)
    const orderEvents = await fetchEvents([{
      authors: [pubkey],
      kinds: [30078],
      '#d': ['noornote:tribe-folders-order']
    }], 5000);

    let folderOrder: string[] = [];
    if (orderEvents.length > 0) {
      const sortedOrderEvents = orderEvents.sort((a, b) => b.created_at - a.created_at);
      const orderEvent = sortedOrderEvents[0];
      if (orderEvent) {
        folderOrder = orderEvent.tags
          .filter(t => t[0] === 'a' && t[1]?.startsWith('30000:'))
          .map(t => {
            const parts = t[1]?.split(':') || [];
            const dTag = parts[2] || '';
            return dTag.startsWith('tribes/') ? dTag.substring(7) : dTag;
          })
          .filter(d => d !== '');
      }
    }

    // Build categories array
    const categories: string[] = ['tribes/'];

    if (folderOrder.length > 0) {
      for (const tribeName of folderOrder) {
        const dTag = `tribes/${tribeName}`;
        if (eventsByDTag.has(dTag)) {
          categories.push(dTag);
        }
      }
      // Add any not in metadata
      for (const dTag of eventsByDTag.keys()) {
        if (dTag !== 'tribes/' && !categories.includes(dTag)) {
          categories.push(dTag);
        }
      }
    } else {
      // Alphabetical fallback
      const sortedDTags = Array.from(eventsByDTag.keys())
        .filter(d => d !== 'tribes/')
        .sort();
      categories.push(...sortedDTags);
    }

    const allItems: TribeMember[] = [];
    const categoryAssignments = new Map<string, string>();

    for (const dTag of categories) {
      const event = eventsByDTag.get(dTag);
      if (!event) continue;

      const tribeName = dTag === 'tribes/' ? '' : dTag.substring(7);
      const hasContent = event.content && event.content.trim() !== '';

      // Extract public members from p-tags
      const publicItems = tagsToMembers(event.tags, event.created_at);
      for (const item of publicItems) {
        item.isPrivate = false;
        item.category = tribeName;
        categoryAssignments.set(item.pubkey, tribeName);
      }

      // Extract private members
      let privateItems: TribeMember[] = [];
      if (hasContent) {
        try {
          privateItems = await decryptPrivateMembers(event.content, pubkey);
          for (const item of privateItems) {
            item.isPrivate = true;
            item.category = tribeName;
            categoryAssignments.set(item.pubkey, tribeName);
          }
        } catch (error) {
          logger.error('tribes.ts', `Failed to decrypt private members: ${error}`);
        }
      }

      allItems.push(...publicItems, ...privateItems);
      logger.info('tribes.ts', `Fetched tribe "${tribeName || 'root'}": ${publicItems.length} public + ${privateItems.length} private`);
    }

    // Deduplicate by pubkey
    const itemMap = new Map<string, TribeMember>();
    for (const item of allItems) {
      itemMap.set(item.pubkey, item);
    }

    return {
      items: Array.from(itemMap.values()),
      relayContentWasEmpty: false,
      categoryAssignments,
      categories
    };
  } catch (error) {
    logger.error('tribes.ts', `Failed to fetch from relays: ${error}`);
    return { items: [], relayContentWasEmpty: true };
  }
}

/**
 * Publish tribes to relays
 */
export async function publishToRelays(): Promise<void> {
  const user = requireAuth();
  const setData = buildSetDataFromBrowser();

  // Get local tribes (with "tribes/" prefix for comparison)
  const localTribes = new Set(
    setData.sets.map(s => s.d === '' ? 'tribes/' : `tribes/${s.d}`)
  );

  // Fetch existing to find deleted
  const relayResult = await fetchFromRelays();
  const relayTribes = new Set(relayResult.categories || []);

  // Find deleted tribes
  const deletedTribes: string[] = [];
  for (const relayTribe of relayTribes) {
    if (!localTribes.has(relayTribe)) {
      deletedTribes.push(relayTribe);
    }
  }

  logger.info('tribes.ts', `Publishing: ${setData.sets.length} sets, ${deletedTribes.length} deleted`);

  // Publish deletions
  if (deletedTribes.length > 0) {
    const coords = deletedTribes.map(dTag => `30000:${user.pubkey}:${dTag}`);
    const deletionService = DeletionService.getInstance();
    await deletionService.deleteByCoordinates(coords, 'Tribe deleted');
  }

  // Publish each tribe
  let totalPublished = 0;

  for (const set of setData.sets) {
    // Skip empty sets (except root)
    if (set.publicMembers.length === 0 && set.privateMembers.length === 0 && set.d !== '') {
      continue;
    }

    const dTagForRelay = set.d === '' ? 'tribes/' : `tribes/${set.d}`;

    // Build tags
    const tags: string[][] = [
      ['d', dTagForRelay],
      ['title', set.title || set.d],
      ['client', 'NoorNote']
    ];

    for (const member of set.publicMembers) {
      tags.push(['p', member.pubkey, member.relay || '']);
    }

    // Encrypt private members
    let content = '';
    if (set.privateMembers.length > 0) {
      const privateTags = set.privateMembers.map(m => ['p', m.pubkey, m.relay || '']);
      content = await encryptContent(JSON.stringify(privateTags), user.pubkey);
    }

    const event = {
      kind: 30000,
      created_at: now(),
      tags,
      content,
      pubkey: user.pubkey
    };

    const signed = await signEvent(event);
    if (!signed) {
      logger.error('tribes.ts', `Failed to sign event for tribe: ${set.d}`);
      continue;
    }

    await publishEvent(signed);
    totalPublished++;

    logger.info('tribes.ts', `Published tribe "${set.d || 'root'}": ${set.publicMembers.length} public + ${set.privateMembers.length} private`);
  }

  // Publish folder order metadata (NIP-78)
  const folderOrder = setData.metadata.setOrder.filter(d => d !== '');
  if (folderOrder.length > 0) {
    const orderTags: string[][] = [['d', 'noornote:tribe-folders-order']];

    for (const tribeName of folderOrder) {
      const coordinate = `30000:${user.pubkey}:tribes/${tribeName}`;
      orderTags.push(['a', coordinate]);
    }

    const orderEvent = {
      kind: 30078,
      created_at: now(),
      tags: orderTags,
      content: '',
      pubkey: user.pubkey
    };

    const signedOrderEvent = await signEvent(orderEvent);
    if (signedOrderEvent) {
      await publishEvent(signedOrderEvent);
      logger.info('tribes.ts', `Published folder order metadata with ${folderOrder.length} tribes`);
    }
  }

  logger.info('tribes.ts', `Published ${totalPublished} tribe events to relays`);
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function tagsToMembers(tags: string[][], timestamp: number): TribeMember[] {
  const items: TribeMember[] = [];

  for (const tag of tags) {
    if (tag[0] === 'p' && tag[1]) {
      items.push({
        id: tag[1],
        pubkey: tag[1],
        relay: tag[2] || '',
        addedAt: timestamp
      });
    }
  }

  return items;
}

async function decryptPrivateMembers(ciphertext: string, pubkey: string): Promise<TribeMember[]> {
  const plaintext = await decryptContent(ciphertext, pubkey);
  if (!plaintext) return [];

  try {
    const tags: string[][] = JSON.parse(plaintext);
    return tagsToMembers(tags, now());
  } catch {
    return [];
  }
}
