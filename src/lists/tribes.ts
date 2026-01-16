/**
 * tribes.ts - ALL tribe logic in ONE file
 *
 * Contains:
 * - Data types
 * - Browser storage (localStorage)
 * - File storage (Tauri)
 * - Relay operations (NIP-51)
 * - TribeManager (UI component for sidebar)
 * - TribeView (view component for timeline)
 * - TribeStorageAdapter (for AutoSyncService)
 *
 * GOAL: Claude can understand and fix tribe bugs without navigating between files.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { StorageKeys, readList, writeList, deduplicateByPubkey, now } from './storage';
import { readJsonFile, writeJsonFile } from './file';
import {
  fetchEvents, publishEvent, signEvent,
  encryptContent, decryptContent,
  requireAuth, getCurrentUserPubkey
} from './relays';
import { PerAccountLocalStorage, type StorageKey } from '../services/PerAccountLocalStorage';
import { SystemLogger } from '../components/system/SystemLogger';
import { EventBus } from '../services/EventBus';
import { DeletionService } from '../services/DeletionService';
import { AuthService } from '../services/AuthService';
import { ToastService } from '../services/ToastService';
import { ModalService } from '../services/ModalService';
import { UserProfileService, type UserProfile } from '../services/UserProfileService';
import { Router } from '../services/Router';
import { encodeNpub } from '../services/NostrToolsAdapter';
import { renderListSyncButtons, bindSwitchSyncModeLink } from '../helpers/ListSyncMode';
import { NewFolderModal } from '../components/modals/NewFolderModal';
import { EditFolderModal } from '../components/modals/EditFolderModal';
import { FolderCard, type FolderData } from '../components/bookmarks/FolderCard';
import { UpNavigator } from '../components/bookmarks/UpNavigator';
import { SyncConfirmationModal } from '../components/modals/SyncConfirmationModal';
import { View } from '../components/views/View';
import { Timeline } from '../components/timeline/Timeline';
import { BaseListStorageAdapter } from '../services/sync/adapters/BaseListStorageAdapter';
import { ListSyncManager } from '../services/sync/ListSyncManager';
import type { FetchFromRelaysResult as AdapterFetchResult } from '../services/sync/ListStorageAdapter';

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

interface MemberWithProfile extends TribeMember {
  profile?: UserProfile;
  isPrivate: boolean;
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
  // Use deterministic ID based on name for consistency across file/relay sync
  const id = `folder_${name}`;
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

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
 * Protection: Won't overwrite browser data with empty file
 */
export async function restoreFromFile(): Promise<void> {
  const data = await readFromFile();
  const { members, folders, assignments, rootOrder } = extractFromSetData(data);

  // Protection: Don't overwrite browser data with empty file
  if (members.length === 0) {
    const browserMembers = getMembers();
    if (browserMembers.length > 0) {
      logger.warn('tribes.ts', `Restore aborted: file empty but browser has ${browserMembers.length} members`);
      throw new Error('File is empty. Use "Sync from Relays" to restore your tribes.');
    }
  }

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
  _categoryAssignments: Map<string, string> | undefined,
  categories: string[] | undefined
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

      // Create folder (use deterministic ID based on name for consistency with extractFromSetData)
      const folderId = `folder_${tribeName}`;
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

  function addMemberToSet(set: TribeSet, item: TribeMember): void {
    const tag: TribeMemberTag = { pubkey: item.pubkey };
    if (item.relay) tag.relay = item.relay;

    const targetArray = item.isPrivate ? set.privateMembers : set.publicMembers;
    targetArray.push(tag);
  }

  // Process folders in order
  for (const folder of folders) {
    const set = setsMap.get(folder.name);
    if (!set) continue;
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
  const rootSet = setsMap.get('');
  if (!rootSet) return createEmptyTribeSetData();
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

// ============================================================
// TRIBE MANAGER (UI Component for Sidebar)
// ============================================================

export class TribeManager {
  private containerElement: HTMLElement;
  private authService: AuthService;
  private modalService: ModalService;
  private profileService: UserProfileService;
  private listSyncManager: ListSyncManager<TribeMember>;
  private adapter: TribeStorageAdapter;

  // View state
  private currentFolderId: string = ''; // '' = root
  private membersCache: Map<string, MemberWithProfile> = new Map();
  private isLoading: boolean = false;

  // Event handler for cleanup
  private closeDropdownHandler: ((e: Event) => void) | null = null;

  constructor(containerElement: HTMLElement) {
    this.containerElement = containerElement;
    this.authService = AuthService.getInstance();
    this.modalService = ModalService.getInstance();
    this.profileService = UserProfileService.getInstance();
    this.adapter = new TribeStorageAdapter();
    this.listSyncManager = new ListSyncManager(this.adapter);

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    eventBus.on('tribe:updated', () => {
      this.refreshIfActive();
    });

    eventBus.on('user:logout', () => {
      this.currentFolderId = '';
      this.membersCache.clear();
    });

    // On user switch, clear cache and refresh if active
    eventBus.on('user:login', () => {
      this.currentFolderId = '';
      this.membersCache.clear();
      this.refreshIfActive();
    });

    // Re-render when sync mode changes (Manual <-> Easy)
    eventBus.on('list-sync-mode:changed', () => {
      this.refreshIfActive();
    });
  }

  private refreshIfActive(): void {
    const listTab = this.containerElement.querySelector('[data-tab-content="list-tribes"]');
    if (listTab && listTab.classList.contains('tab-content--active')) {
      this.renderTribesTab(listTab as HTMLElement);
    }
  }

  /**
   * Handle tab switch (called by MainLayout)
   */
  public handleTabSwitch(tabName: string, content: HTMLElement): void {
    if (tabName === 'tribes') {
      this.renderTribesTab(content);
    }
  }

  /**
   * Public render method (called by MainLayout)
   */
  public async renderListTab(container: HTMLElement): Promise<void> {
    await this.renderTribesTab(container);
  }

  /**
   * Main render function
   */
  private async renderTribesTab(container: HTMLElement): Promise<void> {
    const currentUser = this.authService.getCurrentUser();

    if (!currentUser) {
      container.innerHTML = `
        <div class="tribes-empty-state">
          <p>Log in to see your tribes</p>
        </div>
      `;
      return;
    }

    // Show loading
    container.innerHTML = `
      <div class="tribes-loading">Loading tribes...</div>
    `;

    try {
      // Fetch all members from browser storage
      await this.loadMembers();

      // Render the view
      await this.renderCurrentView(container);
    } catch (error) {
      console.error('Failed to render tribes:', error);
      container.innerHTML = `
        <div class="tribes-empty-state">
          <p>Failed to load tribes</p>
        </div>
      `;
    }
  }

  /**
   * Load all tribe members and their profiles
   */
  private async loadMembers(): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;

    try {
      // Check browser storage first
      let membersFromBrowser = getMembers();

      // If empty, try to restore from file
      if (membersFromBrowser.length === 0) {
        try {
          const fileMembers = await getFileMembers();
          if (fileMembers.length > 0) {
            await restoreFromFile();
            membersFromBrowser = getMembers();
          }
        } catch {
          // File restore failed, try relays
        }
      }

      // If still empty, try relays
      if (membersFromBrowser.length === 0) {
        try {
          const relayResult = await fetchFromRelays();
          if (relayResult.items.length > 0) {
            // Apply relay result with folders and assignments
            applyRelayFetchResult(
              relayResult.items,
              relayResult.categoryAssignments,
              relayResult.categories
            );
            membersFromBrowser = getMembers();
          }
        } catch {
          // Relay fetch failed, continue with empty
        }
      }

      if (membersFromBrowser.length === 0) {
        this.membersCache.clear();
        return;
      }

      // Sort members by addedAt DESC (newest first) for initial display
      const sortedMembers = [...membersFromBrowser].sort((a, b) =>
        (b.addedAt || 0) - (a.addedAt || 0)
      );

      // Fetch profiles for all members
      const profiles = await Promise.all(
        sortedMembers.map(m => this.profileService.getUserProfile(m.pubkey))
      );

      this.membersCache.clear();

      // Check if this is first initialization (no root order yet)
      const isFirstInit = !hasRootOrder();

      // Process in sorted order (newest first)
      for (let i = 0; i < sortedMembers.length; i++) {
        const member = sortedMembers[i];
        if (!member) continue;
        const profile = profiles[i];
        const memberWithProfile: MemberWithProfile = {
          id: member.id,
          pubkey: member.pubkey,
          isPrivate: member.isPrivate || false
        };
        if (member.relay) memberWithProfile.relay = member.relay;
        if (member.addedAt) memberWithProfile.addedAt = member.addedAt;
        if (member.category) memberWithProfile.category = member.category;
        if (profile) memberWithProfile.profile = profile;
        this.membersCache.set(member.pubkey, memberWithProfile);
      }

      // On first init, build root order from sorted members (newest first)
      if (isFirstInit) {
        const rootOrderItems = sortedMembers.map(m => ({ type: 'member' as const, id: m.id }));
        setRootOrder(rootOrderItems);
      }
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Render current view (root or folder)
   */
  private async renderCurrentView(container: HTMLElement): Promise<void> {
    const isInFolder = this.currentFolderId !== '';
    const folder = isInFolder ? getFolder(this.currentFolderId) : undefined;

    // Build HTML structure
    container.innerHTML = `
      ${this.renderSyncControls()}
      ${this.renderHeader(folder)}
      ${isInFolder ? this.renderBreadcrumb(folder) : ''}
      <div class="grid-3-col"></div>
      ${this.renderSyncControls()}
    `;

    // Bind sync buttons
    this.bindSyncButtons(container);

    // Bind header buttons
    this.bindHeaderButtons(container);

    // Render grid content
    const grid = container.querySelector('.grid-3-col') as HTMLElement;
    await this.renderGridContent(grid);
  }

  /**
   * Render sync controls based on sync mode (Manual vs Easy)
   */
  private renderSyncControls(): string {
    return renderListSyncButtons();
  }

  /**
   * Render header with New dropdown button
   */
  private renderHeader(folder: TribeFolder | undefined): string {
    const title = folder ? folder.name : 'Tribes';

    return `
      <div class="bookmark-header">
        <span class="bookmark-header__title">${escapeHtml(title)}</span>
        <div class="bookmark-header__new-dropdown">
            <button class="bookmark-header__new-btn" title="Create new">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 5V19M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
              New
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" class="bookmark-header__new-chevron">
                <path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
            <div class="bookmark-header__dropdown-menu">
              <button class="bookmark-header__dropdown-item" data-action="new-tribe">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M3 7C3 5.89543 3.89543 5 5 5H9.58579C9.851 5 10.1054 5.10536 10.2929 5.29289L12 7H19C20.1046 7 21 7.89543 21 9V17C21 18.1046 20.1046 19 19 19H5C3.89543 19 3 18.1046 3 17V7Z" stroke="currentColor" stroke-width="1.5"/>
                </svg>
                Tribe
              </button>
              <button class="bookmark-header__dropdown-item" data-action="new-member">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                Member
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render breadcrumb navigation
   */
  private renderBreadcrumb(folder: TribeFolder | undefined): string {
    if (!folder) return '';

    return `
      <div class="bookmark-breadcrumb">
        <span class="bookmark-breadcrumb__item" data-navigate="root">Tribes</span>
        <span class="bookmark-breadcrumb__separator">/</span>
        <span class="bookmark-breadcrumb__item bookmark-breadcrumb__item--current">${escapeHtml(folder.name)}</span>
      </div>
    `;
  }

  /**
   * Render grid content (cards)
   */
  private async renderGridContent(grid: HTMLElement): Promise<void> {
    grid.innerHTML = '';

    if (this.currentFolderId !== '') {
      // In a folder - show up navigator first
      const upNav = new UpNavigator({
        onClick: () => this.navigateToRoot(),
        onDrop: async (memberPubkey) => {
          await this.moveMemberToFolderUI(memberPubkey, '');
        }
      });
      grid.appendChild(upNav.render());

      // Get members in this folder
      const memberIds = getMembersInFolder(this.currentFolderId);
      for (const memberId of memberIds) {
        const pubkey = extractPubkeyFromMemberId(memberId);
        const member = this.membersCache.get(pubkey);
        if (member) {
          const card = await this.createMemberCard(member);
          grid.appendChild(card);
        }
      }
    } else {
      // Root view - mixed folders and members
      const rootOrderItems = getRootOrder();
      const renderedIds = new Set<string>();

      for (const item of rootOrderItems) {
        if (item.type === 'folder') {
          const folder = getFolder(item.id);
          if (folder) {
            const card = this.createFolderCard(folder);
            grid.appendChild(card);
            renderedIds.add(item.id);
          }
        } else if (item.type === 'member') {
          const pubkey = extractPubkeyFromMemberId(item.id);
          const member = this.membersCache.get(pubkey);
          const folderId = getMemberFolder(item.id);
          // Only show if in root (no folder assignment)
          if (member && folderId === '') {
            const card = await this.createMemberCard(member);
            grid.appendChild(card);
            renderedIds.add(item.id);
          }
        }
      }

      // Add any new items not in root order yet
      const folders = getFolders();
      for (const folder of folders) {
        if (!renderedIds.has(folder.id)) {
          const card = this.createFolderCard(folder);
          grid.appendChild(card);
          addToRootOrder('folder', folder.id);
        }
      }

      for (const [, member] of this.membersCache) {
        const memberId = member.id;
        const folderId = getMemberFolder(memberId);
        if (folderId === '' && !renderedIds.has(memberId)) {
          const card = await this.createMemberCard(member);
          grid.appendChild(card);
          addToRootOrder('member', memberId);
        }
      }
    }

    // Check empty state
    if (grid.children.length === 0) {
      grid.innerHTML = `
        <div class="tribes-empty-state" style="grid-column: 1 / -1;">
          <p>No tribe members yet</p>
        </div>
      `;
    }

    // Setup drag & drop for reordering
    this.setupGridDragDrop(grid);
  }

  /**
   * Create a member card
   */
  private async createMemberCard(member: MemberWithProfile): Promise<HTMLElement> {
    const card = new TribeMemberCard({
      pubkey: member.pubkey,
      isPrivate: member.isPrivate,
      folderId: getMemberFolder(member.id)
    }, {
      onDelete: async (pubkey: string) => {
        await this.deleteMember(pubkey);
      }
    });

    return await card.render();
  }

  /**
   * Get actual item count for a folder by counting real items in browser storage
   */
  private getActualFolderItemCount(folderId: string): number {
    const realMemberPubkeys = new Set(getMembers().map(m => m.pubkey));
    const assignedPubkeys = getMemberPubkeysInFolder(folderId);
    return assignedPubkeys.filter(pk => realMemberPubkeys.has(pk)).length;
  }

  /**
   * Create a folder card
   */
  private createFolderCard(folder: TribeFolder): HTMLElement {
    const folderData: FolderData = {
      id: folder.id,
      name: folder.name,
      itemCount: this.getActualFolderItemCount(folder.id),
      isMounted: false // Tribes don't support profile mounting
    };

    const card = new FolderCard(folderData, {
      onClick: (folderId) => this.navigateToFolder(folderId),
      onEdit: (folderId) => this.editFolder(folderId),
      onDelete: async (folderId) => {
        await this.deleteFolderUI(folderId);
      },
      onDrop: async (memberPubkey, folderId) => {
        await this.moveMemberToFolderUI(memberPubkey, folderId);
      },
      onDragStart: (_folderId) => {
        // Drag state tracked internally by setupGridDragDrop
      },
      onDragEnd: () => {
        // Drag state tracked internally by setupGridDragDrop
      },
      showMountCheckbox: false // Tribes don't support profile mounting
    });

    return card.render();
  }

  /**
   * Setup mouse-based drag & drop for grid reordering
   */
  private setupGridDragDrop(grid: HTMLElement): void {
    let draggedCard: HTMLElement | null = null;
    let draggedId: string | null = null;
    let placeholder: HTMLElement | null = null;
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let offsetX = 0;
    let offsetY = 0;

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.tribe-member-card__delete') || target.closest('.folder-card__delete')) {
        return;
      }

      const card = target.closest('.tribe-member-card, .folder-card') as HTMLElement;
      if (!card || card.classList.contains('up-navigator')) return;

      e.preventDefault();
      draggedCard = card;
      draggedId = card.dataset.pubkey || card.dataset.folderId || null;
      startX = e.clientX;
      startY = e.clientY;

      const rect = card.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!draggedCard) return;

      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);

      if (!isDragging && (dx > 5 || dy > 5)) {
        isDragging = true;
        draggedCard.dataset.wasDragging = 'true';
        draggedCard.classList.add('dragging');

        placeholder = document.createElement('div');
        placeholder.className = 'tribe-member-card-placeholder';
        placeholder.style.width = draggedCard.offsetWidth + 'px';
        placeholder.style.height = draggedCard.offsetHeight + 'px';
        draggedCard.parentNode?.insertBefore(placeholder, draggedCard);

        draggedCard.style.position = 'fixed';
        draggedCard.style.zIndex = '1000';
        draggedCard.style.width = draggedCard.offsetWidth + 'px';
        draggedCard.style.pointerEvents = 'none';
      }

      if (isDragging) {
        draggedCard.style.left = (e.clientX - offsetX) + 'px';
        draggedCard.style.top = (e.clientY - offsetY) + 'px';

        const elemBelow = document.elementFromPoint(e.clientX, e.clientY);
        const cardBelow = elemBelow?.closest('.tribe-member-card:not(.dragging), .folder-card:not(.dragging), .up-navigator') as HTMLElement;

        grid.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));

        if (cardBelow && cardBelow !== placeholder) {
          cardBelow.classList.add('drag-over');
        }
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      if (!draggedCard || !isDragging) {
        draggedCard = null;
        isDragging = false;
        return;
      }

      const savedDisplay = draggedCard.style.display;
      draggedCard.style.display = 'none';
      const elemBelow = document.elementFromPoint(e.clientX, e.clientY);
      draggedCard.style.display = savedDisplay;
      const dropTarget = elemBelow?.closest('.tribe-member-card, .folder-card, .up-navigator') as HTMLElement;

      draggedCard.classList.remove('dragging');
      draggedCard.style.position = '';
      draggedCard.style.zIndex = '';
      draggedCard.style.width = '';
      draggedCard.style.left = '';
      draggedCard.style.top = '';
      draggedCard.style.pointerEvents = '';

      grid.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));

      placeholder?.remove();
      placeholder = null;

      if (dropTarget && draggedId && draggedCard) {
        const targetId = dropTarget.dataset.pubkey || dropTarget.dataset.folderId;
        const isDraggingMember = draggedCard.classList.contains('tribe-member-card');
        const isDraggingFolder = draggedCard.classList.contains('folder-card');
        const isTargetFolder = dropTarget.classList.contains('folder-card');
        const isTargetUpNav = dropTarget.classList.contains('up-navigator');

        if (isTargetUpNav && isDraggingMember) {
          this.moveMemberToFolderUI(draggedId, '');
        } else if (isTargetFolder && isDraggingMember && targetId) {
          this.moveMemberToFolderUI(draggedId, targetId);
        } else if (targetId && targetId !== draggedId) {
          if (this.currentFolderId && isDraggingMember) {
            const membersInFolderList = getMembersInFolder(this.currentFolderId);
            const targetIndex = membersInFolderList.findIndex(id => id === targetId);
            if (targetIndex !== -1) {
              moveItemToPosition(draggedId, targetIndex);
              grid.insertBefore(draggedCard, dropTarget);
              eventBus.emit('tribe:updated');
            }
          } else {
            const draggedType = isDraggingFolder ? 'folder' : 'member';
            const rootOrderItems = getRootOrder();
            const targetIndex = rootOrderItems.findIndex(item => item.id === targetId);
            if (targetIndex !== -1) {
              moveInRootOrder(draggedType as 'folder' | 'member', draggedId, targetIndex);
              grid.insertBefore(draggedCard, dropTarget);
              eventBus.emit('tribe:updated');
            }
          }
        }
      }

      draggedCard = null;
      draggedId = null;
      isDragging = false;
    };

    grid.addEventListener('mousedown', onMouseDown);
  }

  private navigateToFolder(folderId: string): void {
    this.currentFolderId = folderId;
    this.rerenderCurrentView();
  }

  private navigateToRoot(): void {
    this.currentFolderId = '';
    this.rerenderCurrentView();
  }

  private rerenderCurrentView(): void {
    const container = this.containerElement.querySelector('[data-tab-content="list-tribes"]');
    if (container) {
      this.renderCurrentView(container as HTMLElement);
    }
  }

  /**
   * Delete member from tribe
   */
  private async deleteMember(pubkey: string): Promise<void> {
    try {
      removeMember(pubkey);
      this.membersCache.delete(pubkey);

      ToastService.show('Member removed', 'success');
      this.rerenderCurrentView();
    } catch (error) {
      console.error('Failed to delete member:', error);
      ToastService.show('Failed to remove member', 'error');
    }
  }

  /**
   * Edit folder (rename)
   */
  private editFolder(folderId: string): void {
    const folder = getFolder(folderId);
    if (!folder) return;

    const modal = new EditFolderModal({
      currentName: folder.name,
      onSave: (newName: string) => {
        renameFolder(folderId, newName);
        ToastService.show('Tribe renamed', 'success');
        this.rerenderCurrentView();
      }
    });

    modal.show();
  }

  /**
   * Delete folder (UI handler with confirmation)
   */
  private async deleteFolderUI(folderId: string): Promise<void> {
    const folder = getFolder(folderId);
    if (!folder) return;

    const itemCount = this.getActualFolderItemCount(folderId);
    const message = itemCount > 0
      ? `Delete tribe "${folder.name}"? ${itemCount} member(s) will be deleted.`
      : `Delete tribe "${folder.name}"?`;

    this.modalService.show({
      title: 'Delete Tribe',
      content: `
        <div style="padding: 1rem 0;">
          <p>${message}</p>
        </div>
        <div style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1.5rem;">
          <button class="btn" data-action="cancel">Cancel</button>
          <button class="btn btn--danger" data-action="confirm">Delete</button>
        </div>
      `,
      width: '400px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true
    });

    setTimeout(() => {
      const cancelBtn = document.querySelector('[data-action="cancel"]');
      const confirmBtn = document.querySelector('[data-action="confirm"]');

      cancelBtn?.addEventListener('click', () => {
        this.modalService.hide();
      });

      confirmBtn?.addEventListener('click', async () => {
        try {
          // Get member pubkeys and delete them
          const pubkeys = getMemberPubkeysInFolder(folderId);
          for (const pubkey of pubkeys) {
            removeMember(pubkey);
            this.membersCache.delete(pubkey);
          }

          // Delete folder
          deleteFolder(folderId);

          ToastService.show('Tribe deleted', 'success');

          if (this.currentFolderId === folderId) {
            this.currentFolderId = '';
          }

          this.modalService.hide();
          this.rerenderCurrentView();
        } catch (error) {
          console.error('Failed to delete tribe:', error);
          ToastService.show('Failed to delete tribe', 'error');
          this.modalService.hide();
        }
      });
    }, 0);
  }

  /**
   * Move member to a different folder (UI handler)
   */
  private async moveMemberToFolderUI(memberPubkey: string, targetFolderId: string): Promise<void> {
    try {
      const targetFolder = targetFolderId ? getFolder(targetFolderId) : undefined;
      const targetCategoryName = targetFolder?.name || '';

      // Update folder assignment
      moveMemberToFolder(memberPubkey, targetFolderId);

      // Update category in browser storage
      const currentItems = getMembers();
      const updatedItems = currentItems.map(item => {
        if (item.pubkey === memberPubkey || item.id === memberPubkey) {
          return { ...item, category: targetCategoryName };
        }
        return item;
      });
      setMembers(updatedItems);

      const targetName = targetFolderId === '' ? 'root' : targetFolder?.name || 'tribe';
      ToastService.show(`Moved to ${targetName}`, 'success');
      this.rerenderCurrentView();
    } catch (error) {
      console.error('Failed to move member:', error);
      ToastService.show('Failed to move member', 'error');
    }
  }

  /**
   * Create new tribe (folder)
   */
  private createNewTribe(): void {
    const modal = new NewFolderModal({
      onConfirm: (name: string) => {
        createFolder(name);
        ToastService.show('Tribe created', 'success');
        this.rerenderCurrentView();
      }
    });

    modal.show();
  }

  /**
   * Add new member(s) to tribe
   */
  private addNewMember(): void {
    const allTribes = getFolders();
    const tribeOptions = allTribes.map(t =>
      `<option value="${t.id}">${escapeHtml(t.name)}</option>`
    ).join('');

    const container = document.createElement('div');
    container.className = 'new-bookmark-modal';

    container.innerHTML = `
      <div class="new-bookmark-modal__content">
        <div class="form-group">
          <label for="tribe-member-input">Members (@username, comma-separated)</label>
          <textarea
            id="tribe-member-input"
            class="input"
            placeholder="@alice, @bob, @charlie..."
            rows="3"
            autocomplete="off"
          ></textarea>
          <p style="margin-top: 0.5rem; font-size: 0.875rem; color: var(--color-text-secondary);">Type @ to search your follows</p>
        </div>

        <div class="form-group">
          <label for="tribe-select">Tribe</label>
          <select id="tribe-select" class="input">
            ${allTribes.length === 0 ? '<option value="">No tribes available</option>' : tribeOptions}
          </select>
        </div>

        <div class="new-bookmark-modal__actions">
          <button type="button" class="btn btn--passive" id="tribe-member-cancel-btn">
            Cancel
          </button>
          <button type="button" class="btn" id="tribe-member-save-btn" ${allTribes.length === 0 ? 'disabled' : ''}>
            Add Members
          </button>
        </div>
      </div>
    `;

    this.modalService.show({
      title: 'Add Members to Tribe',
      content: container,
      width: '450px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true
    });

    setTimeout(async () => {
      const input = document.getElementById('tribe-member-input') as HTMLTextAreaElement;
      const tribeSelect = document.getElementById('tribe-select') as HTMLSelectElement;
      const cancelBtn = document.getElementById('tribe-member-cancel-btn');
      const saveBtn = document.getElementById('tribe-member-save-btn');

      input?.focus();

      const { MentionAutocomplete } = await import('../components/mentions/MentionAutocomplete');
      const mentionAutocomplete = new MentionAutocomplete({
        textareaSelector: '#tribe-member-input'
      });
      mentionAutocomplete.init();

      const handleSave = async () => {
        const selectedTribeId = tribeSelect?.value;
        const inputValue = input?.value.trim();

        if (!selectedTribeId || !inputValue) {
          ToastService.show('Please enter members and select a tribe', 'error');
          return;
        }

        await this.processAddMembers(inputValue, selectedTribeId);
        this.modalService.hide();
      };

      cancelBtn?.addEventListener('click', () => {
        this.modalService.hide();
      });

      saveBtn?.addEventListener('click', handleSave);

      input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) {
          handleSave();
        } else if (e.key === 'Escape') {
          this.modalService.hide();
        }
      });
    }, 0);
  }

  /**
   * Process adding members from comma-separated @mentions or npubs
   */
  private async processAddMembers(inputValue: string, tribeId: string): Promise<void> {
    try {
      const { extractPubkeysFromText } = await import('../helpers/nip19');
      const pubkeys = extractPubkeysFromText(inputValue);

      if (pubkeys.length === 0) {
        ToastService.show('No valid npubs or mentions found.', 'error');
        return;
      }

      const folder = getFolder(tribeId);
      const categoryName = folder?.name || '';

      let added = 0;
      const addedPubkeys: string[] = [];

      for (const pubkey of pubkeys) {
        try {
          addMember(pubkey, false, categoryName, tribeId);
          addedPubkeys.push(pubkey);
          added++;
        } catch (error) {
          console.error(`Failed to add member ${pubkey}:`, error);
        }
      }

      if (added > 0) {
        for (const pubkey of addedPubkeys) {
          const profile = await this.profileService.getUserProfile(pubkey);
          const browserItem = getMember(pubkey);
          if (browserItem) {
            this.membersCache.set(pubkey, {
              ...browserItem,
              profile: profile || undefined,
              isPrivate: browserItem.isPrivate || false
            });
          }
        }

        ToastService.show(`Added ${added} member(s)`, 'success');

        if (this.currentFolderId === tribeId || this.currentFolderId === '') {
          this.rerenderCurrentView();
        }
      } else {
        ToastService.show('No members added', 'error');
      }
    } catch (error) {
      console.error('Failed to add members:', error);
      ToastService.show('Failed to add members', 'error');
    }
  }

  /**
   * Bind sync buttons
   */
  private bindSyncButtons(container: HTMLElement): void {
    container.querySelectorAll('.sync-from-relays-btn').forEach(btn => {
      btn.addEventListener('click', () => this.handleSyncFromRelays(container));
    });

    container.querySelectorAll('.sync-to-relays-btn').forEach(btn => {
      btn.addEventListener('click', () => this.handleSyncToRelays());
    });

    container.querySelectorAll('.save-to-file-btn').forEach(btn => {
      btn.addEventListener('click', () => this.handleSaveToFile());
    });

    container.querySelectorAll('.restore-from-file-btn').forEach(btn => {
      btn.addEventListener('click', () => this.handleRestoreFromFile(container));
    });

    bindSwitchSyncModeLink(container, () => this.renderCurrentView(container));
  }

  /**
   * Bind header buttons (New dropdown)
   */
  private bindHeaderButtons(container: HTMLElement): void {
    const newBtn = container.querySelector('.bookmark-header__new-btn');
    const dropdown = container.querySelector('.bookmark-header__new-dropdown');
    const newTribeBtn = container.querySelector('[data-action="new-tribe"]');
    const newMemberBtn = container.querySelector('[data-action="new-member"]');

    const rootNav = container.querySelector('[data-navigate="root"]');
    rootNav?.addEventListener('click', () => this.navigateToRoot());

    if (!newBtn || !dropdown) return;

    newBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('bookmark-header__new-dropdown--open');
    });

    newTribeBtn?.addEventListener('click', () => {
      dropdown.classList.remove('bookmark-header__new-dropdown--open');
      this.createNewTribe();
    });

    newMemberBtn?.addEventListener('click', () => {
      dropdown.classList.remove('bookmark-header__new-dropdown--open');
      this.addNewMember();
    });

    if (this.closeDropdownHandler) {
      document.removeEventListener('click', this.closeDropdownHandler);
    }
    this.closeDropdownHandler = (e: Event) => {
      if (!dropdown.contains(e.target as Node)) {
        dropdown.classList.remove('bookmark-header__new-dropdown--open');
      }
    };
    document.addEventListener('click', this.closeDropdownHandler);
  }

  /**
   * Sync from relays (Manual mode)
   */
  private async handleSyncFromRelays(container: HTMLElement): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      ToastService.show('Please log in first', 'error');
      return;
    }

    try {
      ToastService.show('Fetching from relays...', 'info');
      const result = await this.listSyncManager.syncFromRelays();

      if (result.requiresConfirmation) {
        const modal = new SyncConfirmationModal({
          listType: 'Tribes',
          added: result.diff.added,
          removed: result.diff.removed,
          getDisplayName: async (member: TribeMember) => {
            const cached = this.membersCache.get(member.pubkey);
            if (cached?.profile) return cached.profile.display_name || cached.profile.name || member.pubkey.slice(0, 8) + '...';
            return member.pubkey.slice(0, 8) + '...';
          },
          onKeep: async () => {
            await this.listSyncManager.applySyncFromRelays('merge', result.relayItems, result.relayContentWasEmpty);
            applyRelayFetchResult(this.adapter.getBrowserItems(), result.categoryAssignments, result.categories);
            ToastService.show(`Merged ${result.diff.added.length} from relays (kept ${result.diff.removed.length} local)`, 'success');
            this.membersCache.clear();
            await this.loadMembers();
            await this.renderCurrentView(container);
          },
          onDelete: async () => {
            await this.listSyncManager.applySyncFromRelays('overwrite', result.relayItems, result.relayContentWasEmpty);
            applyRelayFetchResult(result.relayItems, result.categoryAssignments, result.categories);
            ToastService.show(`Synced from relays (added ${result.diff.added.length}, removed ${result.diff.removed.length})`, 'success');
            this.membersCache.clear();
            await this.loadMembers();
            await this.renderCurrentView(container);
          }
        });
        modal.show();
      } else if (result.diff.added.length > 0) {
        await this.listSyncManager.applySyncFromRelays('merge', result.relayItems, result.relayContentWasEmpty);
        applyRelayFetchResult(result.relayItems, result.categoryAssignments, result.categories);
        ToastService.show(`Synced ${result.diff.added.length} member${result.diff.added.length > 1 ? 's' : ''} from relays`, 'success');
        this.membersCache.clear();
        await this.loadMembers();
        await this.renderCurrentView(container);
      } else {
        ToastService.show('Already up to date with relays', 'info');
      }
    } catch (error) {
      console.error('Sync from relays failed:', error);
      ToastService.show('Failed to sync from relays', 'error');
    }
  }

  /**
   * Sync to relays (Manual mode)
   */
  private async handleSyncToRelays(): Promise<void> {
    try {
      ToastService.show('Publishing to relays...', 'info');
      await publishToRelays();
      ToastService.show('Published to relays', 'success');
    } catch (error) {
      console.error('Publish to relays failed:', error);
      ToastService.show('Failed to publish to relays', 'error');
    }
  }

  /**
   * Save to file (Manual mode)
   */
  private async handleSaveToFile(): Promise<void> {
    try {
      ToastService.show('Saving to file...', 'info');
      await saveToFile();
      ToastService.show('Saved to file', 'success');
    } catch (error) {
      console.error('Save to file failed:', error);
      ToastService.show('Failed to save to file', 'error');
    }
  }

  /**
   * Restore from file (Manual mode)
   */
  private async handleRestoreFromFile(container: HTMLElement): Promise<void> {
    try {
      ToastService.show('Reading from file...', 'info');
      const result = await this.listSyncManager.syncFromFile();

      if (result.requiresConfirmation) {
        const modal = new SyncConfirmationModal({
          listType: 'Tribes (File)',
          added: result.diff.added,
          removed: result.diff.removed,
          getDisplayName: async (member: TribeMember) => {
            const cached = this.membersCache.get(member.pubkey);
            if (cached?.profile) return cached.profile.display_name || cached.profile.name || member.pubkey.slice(0, 8) + '...';
            return member.pubkey.slice(0, 8) + '...';
          },
          onKeep: async () => {
            await this.listSyncManager.applySyncFromFile('merge', result.fileItems);
            ToastService.show(`Merged ${result.diff.added.length} from file (kept ${result.diff.removed.length} local)`, 'success');
            this.membersCache.clear();
            await this.loadMembers();
            await this.renderCurrentView(container);
          },
          onDelete: async () => {
            await this.listSyncManager.applySyncFromFile('overwrite', result.fileItems);
            ToastService.show(`Restored from file (added ${result.diff.added.length}, removed ${result.diff.removed.length})`, 'success');
            this.membersCache.clear();
            await this.loadMembers();
            await this.renderCurrentView(container);
          }
        });
        modal.show();
      } else if (result.diff.added.length > 0) {
        await this.listSyncManager.applySyncFromFile('overwrite', result.fileItems);
        ToastService.show(`Restored ${result.diff.added.length} member${result.diff.added.length > 1 ? 's' : ''} from file`, 'success');
        this.membersCache.clear();
        await this.loadMembers();
        await this.renderCurrentView(container);
      } else {
        ToastService.show('File is identical to current list', 'info');
      }
    } catch (error) {
      console.error('Restore from file failed:', error);
      ToastService.show(`Failed to restore from file: ${error}`, 'error');
    }
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    if (this.closeDropdownHandler) {
      document.removeEventListener('click', this.closeDropdownHandler);
      this.closeDropdownHandler = null;
    }
  }
}

// ============================================================
// TRIBE VIEW (View Component for Timeline)
// ============================================================

export class TribeView extends View {
  private container: HTMLElement;
  private timeline: Timeline | null = null;
  private authService: AuthService;
  private currentTribeId: string = ''; // Current folder ID
  private currentTribes: TribeFolder[] = [];

  constructor() {
    super();
    this.authService = AuthService.getInstance();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--tribe';
    this.render();
  }

  /**
   * Render the view
   */
  private async render(): Promise<void> {
    // Get current user
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.container.innerHTML = '<div class="tribe-view__error">Please login to view tribes</div>';
      return;
    }

    // Load tribes in root order
    this.currentTribes = getFoldersInRootOrder();

    if (this.currentTribes.length === 0 || !this.currentTribes[0]) {
      this.container.innerHTML = '<div class="tribe-view__error">No tribes found. Create one in the sidebar.</div>';
      return;
    }

    // Set first tribe as current
    this.currentTribeId = this.currentTribes[0].id;

    // Build header with tabs and edit link
    const header = document.createElement('div');
    header.className = 'tribe-view__header';

    // Tabs container
    const tabsContainer = document.createElement('div');
    tabsContainer.className = 'tribe-view__tabs-container';

    // Tabs
    const tabs = document.createElement('div');
    tabs.className = 'tabs';

    // Tribe tabs (in root order)
    for (let i = 0; i < this.currentTribes.length; i++) {
      const tribe = this.currentTribes[i];
      if (!tribe) continue;
      const isActive = i === 0; // First tribe is active
      const tab = this.createTab(tribe.id, tribe.name, isActive);
      tabs.appendChild(tab);
    }

    tabsContainer.appendChild(tabs);

    // Edit link
    const editLink = document.createElement('button');
    editLink.className = 'tribe-view__edit-link';
    editLink.textContent = 'Edit ›';
    editLink.addEventListener('click', () => {
      eventBus.emit('list:open', { listType: 'tribes' });
    });

    tabsContainer.appendChild(editLink);
    header.appendChild(tabsContainer);
    this.container.appendChild(header);

    // Timeline container
    const timelineContainer = document.createElement('div');
    timelineContainer.className = 'tribe-view__timeline';
    this.container.appendChild(timelineContainer);

    // Create initial timeline for first tribe
    await this.updateTimeline(currentUser.pubkey);
  }

  /**
   * Create a tab button
   */
  private createTab(tribeId: string, name: string, isActive: boolean): HTMLElement {
    const tab = document.createElement('button');
    tab.className = `tab${isActive ? ' tab--active' : ''}`;
    tab.dataset.tribeId = tribeId;
    tab.textContent = name;

    tab.addEventListener('click', async () => {
      // Update active state
      this.container.querySelectorAll('.tab').forEach(t => t.classList.remove('tab--active'));
      tab.classList.add('tab--active');

      // Update current tribe
      this.currentTribeId = tribeId;

      // Reload timeline
      const currentUser = this.authService.getCurrentUser();
      if (currentUser) {
        await this.updateTimeline(currentUser.pubkey);
      }
    });

    return tab;
  }

  /**
   * Update timeline based on selected tribe
   */
  private async updateTimeline(userPubkey: string): Promise<void> {
    // Get member pubkeys for selected tribe
    const tribePubkeys = getMemberPubkeysInFolder(this.currentTribeId);

    // Destroy existing timeline
    if (this.timeline) {
      this.timeline.destroy();
      this.timeline = null;
    }

    // Create new timeline with tribe filter
    this.timeline = new Timeline(userPubkey, undefined, tribePubkeys);

    // Mount timeline
    const timelineContainer = this.container.querySelector('.tribe-view__timeline');
    if (timelineContainer) {
      timelineContainer.innerHTML = '';
      timelineContainer.appendChild(this.timeline.getElement());
    }
  }

  /**
   * Get element
   */
  public getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Destroy view
   */
  public destroy(): void {
    if (this.timeline) {
      this.timeline.destroy();
      this.timeline = null;
    }
    this.container.innerHTML = '';
  }

  /**
   * Pause timeline when navigating away
   */
  public override pause(): void {
    if (this.timeline) {
      this.timeline.pause();
    }
  }

  /**
   * Resume timeline when navigating back
   */
  public override resume(): void {
    if (this.timeline) {
      this.timeline.resume();
    }
  }
}

// ============================================================
// TRIBE MEMBER CARD (UI component for displaying members)
// ============================================================

export interface TribeMemberCardData {
  pubkey: string;
  isPrivate: boolean;
  folderId?: string;
}

export interface TribeMemberCardOptions {
  onDelete: (pubkey: string) => Promise<void>;
}

export class TribeMemberCard {
  private data: TribeMemberCardData;
  private options: TribeMemberCardOptions;
  private element: HTMLElement | null = null;
  private userProfileService: UserProfileService;
  private router: Router;

  constructor(data: TribeMemberCardData, options: TribeMemberCardOptions) {
    this.data = data;
    this.options = options;
    this.userProfileService = UserProfileService.getInstance();
    this.router = Router.getInstance();
  }

  public async render(): Promise<HTMLElement> {
    const { pubkey, isPrivate } = this.data;

    // Create card element
    const card = document.createElement('div');
    card.className = 'tribe-member-card';
    card.dataset.pubkey = pubkey;

    // Fetch user profile
    const profile = await this.userProfileService.getUserProfile(pubkey);
    const username = profile?.name || profile?.display_name || 'Anonymous';
    const profilePic = profile?.picture || '';

    // NIP-05: prefer nip05s from tags, fallback to single nip05 from content
    const nip05s = profile?.nip05s?.length ? profile.nip05s : (profile?.nip05 ? [profile.nip05] : []);
    const nip05Display = nip05s.join(', ');

    card.innerHTML = `
      ${isPrivate ? '<span class="tribe-member-card__private-badge">🔒</span>' : ''}
      <div class="tribe-member-card__content">
        <div class="tribe-member-card__avatar">
          ${profilePic
            ? `<img class="tribe-member-card__avatar-img" src="${escapeHtml(profilePic)}" alt="" loading="lazy" />`
            : '<div class="tribe-member-card__avatar-img tribe-member-card__avatar-img--empty"></div>'
          }
        </div>
        <div class="tribe-member-card__info">
          <span class="tribe-member-card__username">${escapeHtml(username)}</span>
          ${nip05Display ? `<span class="tribe-member-card__nip05">${escapeHtml(nip05Display)}</span>` : `<span class="tribe-member-card__pubkey">${escapeHtml(pubkey.slice(0, 8))}...</span>`}
        </div>
      </div>
      <button class="tribe-member-card__delete" aria-label="Remove member" title="Remove member">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M3 4h10M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M6 7v4M10 7v4M4 4l.5 8.5a1 1 0 0 0 1 .95h5a1 1 0 0 0 1-.95L12 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    `;

    // Bind events
    this.bindEvents(card);

    this.element = card;
    return card;
  }

  private bindEvents(card: HTMLElement): void {
    const { pubkey } = this.data;

    // Click on card navigates to profile
    card.addEventListener('click', () => {
      // Don't navigate if we were dragging
      if (card.dataset.wasDragging === 'true') {
        card.dataset.wasDragging = 'false';
        return;
      }

      // Navigate to profile
      const npub = encodeNpub(pubkey);
      this.router.navigate(`/profile/${npub}`);
    });

    // Delete button
    const deleteBtn = card.querySelector('.tribe-member-card__delete');
    deleteBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.options.onDelete(pubkey);
      card.remove();
    });
  }

  public getElement(): HTMLElement | null {
    return this.element;
  }

  public getPubkey(): string {
    return this.data.pubkey;
  }
}

// ============================================================
// TRIBE STORAGE ADAPTER (for AutoSyncService)
// ============================================================

export class TribeStorageAdapter extends BaseListStorageAdapter<TribeMember> {
  constructor() {
    super();
  }

  /**
   * Override setBrowserItems to emit tribe:updated event
   */
  override setBrowserItems(items: TribeMember[]): void {
    super.setBrowserItems(items);
    eventBus.emit('tribe:updated');
  }

  protected getBrowserStorageKey(): string {
    return 'noornote_tribes_browser';  // Legacy, for migration only
  }

  protected override getPerAccountStorageKey(): StorageKey {
    return StorageKeys.TRIBES;
  }

  protected getLogPrefix(): string {
    return 'TribeStorageAdapter';
  }

  /**
   * Get unique ID for tribe member (pubkey)
   */
  getItemId(item: TribeMember): string {
    return item.pubkey;
  }

  /**
   * File Storage - read from file
   */
  async getFileItems(): Promise<TribeMember[]> {
    try {
      return await getFileMembers();
    } catch (error) {
      logger.error('TribeStorageAdapter', `Failed to read from file: ${error}`);
      throw error;
    }
  }

  /**
   * File Storage - save to file
   */
  async setFileItems(_items: TribeMember[]): Promise<void> {
    try {
      await saveToFile();
    } catch (error) {
      logger.error('TribeStorageAdapter', `Failed to write to file: ${error}`);
      throw error;
    }
  }

  /**
   * Restore folder data from file to per-account storage
   */
  async restoreFolderDataFromFile(): Promise<void> {
    try {
      await restoreFromFile();
    } catch (error) {
      logger.error('TribeStorageAdapter', `Failed to restore folder data: ${error}`);
    }
  }

  /**
   * Relay Storage - fetch from relays
   */
  async fetchFromRelays(): Promise<AdapterFetchResult<TribeMember>> {
    try {
      return await fetchFromRelays();
    } catch (error) {
      logger.error('TribeStorageAdapter', `Failed to fetch from relays: ${error}`);
      throw error;
    }
  }

  /**
   * Relay Storage - publish to relays
   */
  async publishToRelays(_items: TribeMember[]): Promise<void> {
    try {
      await publishToRelays();
    } catch (error) {
      logger.error('TribeStorageAdapter', `Failed to publish to relays: ${error}`);
      throw error;
    }
  }
}
