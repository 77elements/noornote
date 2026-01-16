/**
 * mutes.ts - ALL mute logic in ONE file
 *
 * Contains:
 * - Data types
 * - Browser storage (localStorage via PerAccountLocalStorage)
 * - File storage (Tauri)
 * - Relay operations (NIP-51 kind:10000)
 * - MuteStorageAdapter (for AutoSyncService)
 * - MuteListView (standalone view)
 * - MuteListManager (sidebar manager)
 * - ProfileMuteManager (profile mute UI)
 *
 * GOAL: Claude can understand and fix mute bugs without navigating between files.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { StorageKeys, now } from './storage';
import { readJsonFile, writeJsonFile } from './file';
import {
  fetchEvents, publishEvent, signEvent,
  encryptContent, decryptContent,
  requireAuth, getCurrentUserPubkey
} from './relays';
import { PerAccountLocalStorage, type StorageKey } from '../services/PerAccountLocalStorage';
import { SystemLogger } from '../components/system/SystemLogger';
import { EventBus } from '../services/EventBus';
import { BaseListStorageAdapter } from '../services/sync/adapters/BaseListStorageAdapter';
import type { FetchFromRelaysResult as AdapterFetchResult } from '../services/sync/ListStorageAdapter';
// UI component imports
import { View } from '../components/views/View';
import { BaseListManager } from '../components/layout/managers/BaseListManager';
import { UserProfileService, type UserProfile } from '../services/UserProfileService';
import { NoteService } from '../services/NoteService';
import { AuthService } from '../services/AuthService';
import { ToastService } from '../services/ToastService';
import { Router } from '../services/Router';
import { hexToNpub } from '../helpers/nip19';
import { extractDisplayName } from '../helpers/extractDisplayName';
import { ListSyncManager } from '../services/sync/ListSyncManager';
import { SyncConfirmationModal } from '../components/modals/SyncConfirmationModal';
import { setupUserMentionHandlers } from '../helpers/UserMentionHelper';

const logger = SystemLogger.getInstance();
const eventBus = EventBus.getInstance();

// ============================================================
// TYPES (exact same format as before - DO NOT CHANGE!)
// ============================================================

/**
 * Unified mute item stored in localStorage
 * Supports both user mutes and thread mutes
 */
export interface MuteItem {
  type: 'user' | 'thread';
  id: string;           // pubkey for users, event ID for threads
  isPrivate: boolean;
  addedAt: number;
}

/**
 * Mute status for a user (used by UI)
 */
export interface MuteStatus {
  public: boolean;
  private: boolean;
  any: boolean;
}

/**
 * File storage format (separate files for public/private)
 */
export interface MuteListData {
  items: string[];      // pubkeys or event IDs
  eventIds: string[];   // thread event IDs (legacy field, kept for compatibility)
  lastModified: number;
}

/**
 * Result from fetching mutes from relays
 */
export interface FetchFromRelaysResult {
  items: MuteItem[];
  relayContentWasEmpty: boolean;
}

// ============================================================
// BROWSER STORAGE (localStorage via PerAccountLocalStorage)
// ============================================================

const storage = PerAccountLocalStorage.getInstance();

/**
 * Read mute items from browser storage
 */
export function getMuteItems(): MuteItem[] {
  return storage.get<MuteItem[]>(StorageKeys.MUTES, []);
}

/**
 * Write mute items to browser storage
 */
export function setMuteItems(items: MuteItem[]): void {
  storage.set(StorageKeys.MUTES, items);
  eventBus.emit('mute:updated', {});
}

/**
 * Clear mute items from browser storage
 */
export function clearMuteItems(): void {
  storage.remove(StorageKeys.MUTES);
}

// ----- User Mutes -----

/**
 * Get all muted user pubkeys
 */
export function getAllMutedUsers(): string[] {
  return getMuteItems()
    .filter(item => item.type === 'user')
    .map(item => item.id);
}

/**
 * Get all muted users with their status
 */
export function getAllMutedUsersWithStatus(): Map<string, MuteStatus> {
  const items = getMuteItems().filter(item => item.type === 'user');
  const statusMap = new Map<string, MuteStatus>();

  for (const item of items) {
    const existing = statusMap.get(item.id);
    if (existing) {
      if (item.isPrivate) {
        existing.private = true;
      } else {
        existing.public = true;
      }
      existing.any = true;
    } else {
      statusMap.set(item.id, {
        public: !item.isPrivate,
        private: item.isPrivate,
        any: true
      });
    }
  }

  return statusMap;
}

/**
 * Check if a user is muted
 */
export function isUserMuted(pubkey: string): MuteStatus {
  const items = getMuteItems().filter(
    item => item.type === 'user' && item.id === pubkey
  );

  if (items.length === 0) {
    return { public: false, private: false, any: false };
  }

  const isPublic = items.some(item => !item.isPrivate);
  const isPrivate = items.some(item => item.isPrivate);

  return {
    public: isPublic,
    private: isPrivate,
    any: true
  };
}

/**
 * Mute a user
 */
export function muteUser(pubkey: string, isPrivate: boolean = false): void {
  requireAuth();

  const items = getMuteItems();

  // Check if already muted with same privacy setting
  const existingIndex = items.findIndex(
    item => item.type === 'user' && item.id === pubkey && item.isPrivate === isPrivate
  );

  if (existingIndex !== -1) {
    return; // Already muted
  }

  // Add new mute
  const newItem: MuteItem = {
    type: 'user',
    id: pubkey,
    isPrivate,
    addedAt: now()
  };

  items.push(newItem);
  setMuteItems(items);

  logger.info('mutes.ts', `Muted user ${pubkey.slice(0, 8)}... (${isPrivate ? 'private' : 'public'})`);
}

/**
 * Unmute a user (from specific list: public or private)
 */
export function unmuteUser(pubkey: string, isPrivate: boolean): void {
  requireAuth();

  const items = getMuteItems();
  const filtered = items.filter(
    item => !(item.type === 'user' && item.id === pubkey && item.isPrivate === isPrivate)
  );

  if (filtered.length !== items.length) {
    setMuteItems(filtered);
    logger.info('mutes.ts', `Unmuted user ${pubkey.slice(0, 8)}... from ${isPrivate ? 'private' : 'public'} list`);
  }
}

/**
 * Unmute a user completely (from both public and private lists)
 */
export function unmuteUserCompletely(pubkey: string): void {
  requireAuth();

  const items = getMuteItems();
  const filtered = items.filter(
    item => !(item.type === 'user' && item.id === pubkey)
  );

  if (filtered.length !== items.length) {
    setMuteItems(filtered);
    logger.info('mutes.ts', `Unmuted user ${pubkey.slice(0, 8)}... completely`);
  }
}

// ----- Thread Mutes -----

/**
 * Get all muted thread event IDs
 */
export function getAllMutedThreads(): string[] {
  return getMuteItems()
    .filter(item => item.type === 'thread')
    .map(item => item.id);
}

/**
 * Get all muted threads with their status
 */
export function getAllMutedThreadsWithStatus(): Map<string, MuteStatus> {
  const items = getMuteItems().filter(item => item.type === 'thread');
  const statusMap = new Map<string, MuteStatus>();

  for (const item of items) {
    statusMap.set(item.id, {
      public: !item.isPrivate,
      private: item.isPrivate,
      any: true
    });
  }

  return statusMap;
}

/**
 * Check if a thread is muted
 */
export function isThreadMuted(eventId: string): boolean {
  return getMuteItems().some(
    item => item.type === 'thread' && item.id === eventId
  );
}

/**
 * Mute a thread (Hell Thread protection)
 */
export function muteThread(eventId: string, isPrivate: boolean = true): void {
  requireAuth();

  const items = getMuteItems();

  // Check if already muted
  if (items.some(item => item.type === 'thread' && item.id === eventId)) {
    return;
  }

  const newItem: MuteItem = {
    type: 'thread',
    id: eventId,
    isPrivate,
    addedAt: now()
  };

  items.push(newItem);
  setMuteItems(items);

  logger.info('mutes.ts', `Muted thread ${eventId.slice(0, 8)}...`);
  eventBus.emit('mute:thread:updated', { eventId });
}

/**
 * Unmute a thread
 */
export function unmuteThread(eventId: string): void {
  requireAuth();

  const items = getMuteItems();
  const filtered = items.filter(
    item => !(item.type === 'thread' && item.id === eventId)
  );

  if (filtered.length !== items.length) {
    setMuteItems(filtered);
    logger.info('mutes.ts', `Unmuted thread ${eventId.slice(0, 8)}...`);
    eventBus.emit('mute:thread:updated', { eventId });
  }
}

// ----- Hell Thread Check -----

/**
 * Check if a note is in a muted thread (cascading check)
 * Checks root event, reply-to event, and mentioned events
 */
export function isInMutedThread(event: NostrEvent): boolean {
  const mutedThreads = getAllMutedThreads();
  if (mutedThreads.length === 0) return false;

  // Check if this event itself is muted
  if (event.id && mutedThreads.includes(event.id)) {
    return true;
  }

  // Check e-tags (root, reply-to, mentions)
  for (const tag of event.tags) {
    if (tag[0] === 'e' && tag[1]) {
      if (mutedThreads.includes(tag[1])) {
        return true;
      }
    }
  }

  return false;
}

// ============================================================
// SETTINGS
// ============================================================

/**
 * Check if private mutes feature is enabled
 */
export function isPrivateMutesEnabled(): boolean {
  try {
    return localStorage.getItem('noornote_nip51_private_mutes_enabled') === 'true';
  } catch {
    return false;
  }
}

/**
 * Set private mutes feature flag
 */
export function setPrivateMutesEnabled(enabled: boolean): void {
  localStorage.setItem('noornote_nip51_private_mutes_enabled', enabled.toString());
}

/**
 * Get encryption method preference (NIP-44 or NIP-04)
 */
export function getEncryptionMethod(): 'nip44' | 'nip04' {
  try {
    const method = localStorage.getItem('noornote_mute_encryption_method');
    return method === 'nip04' ? 'nip04' : 'nip44';
  } catch {
    return 'nip44';
  }
}

/**
 * Set encryption method preference
 */
export function setEncryptionMethod(method: 'nip44' | 'nip04'): void {
  localStorage.setItem('noornote_mute_encryption_method', method);
}

// ============================================================
// TEMPORARY UNMUTE (for viewing muted content temporarily)
// ============================================================

// In-memory set of temporarily unmuted users (session-only)
const temporarilyUnmuted = new Set<string>();

/**
 * Temporarily unmute a user for the current session
 */
export function temporaryUnmute(pubkey: string): void {
  temporarilyUnmuted.add(pubkey);
  logger.info('mutes.ts', `Temporarily unmuted ${pubkey.slice(0, 8)}...`);
}

/**
 * Remove temporary unmute
 */
export function removeTemporaryUnmute(pubkey: string): void {
  temporarilyUnmuted.delete(pubkey);
}

/**
 * Check if a user is temporarily unmuted
 */
export function isTemporarilyUnmuted(pubkey: string): boolean {
  return temporarilyUnmuted.has(pubkey);
}

/**
 * Clear all temporary unmutes
 */
export function clearTemporaryUnmutes(): void {
  temporarilyUnmuted.clear();
}

// ============================================================
// FILE STORAGE (Tauri)
// ============================================================

const PUBLIC_MUTES_FILE = 'mutes-public.json';
const PRIVATE_MUTES_FILE = 'mutes-private.json';

function createEmptyMuteListData(): MuteListData {
  return {
    items: [],
    eventIds: [],
    lastModified: now()
  };
}

/**
 * Read public mutes from file
 */
export async function readPublicMutesFile(): Promise<MuteListData> {
  return await readJsonFile<MuteListData>(PUBLIC_MUTES_FILE, createEmptyMuteListData());
}

/**
 * Read private mutes from file
 */
export async function readPrivateMutesFile(): Promise<MuteListData> {
  return await readJsonFile<MuteListData>(PRIVATE_MUTES_FILE, createEmptyMuteListData());
}

/**
 * Write public mutes to file
 */
export async function writePublicMutesFile(data: MuteListData): Promise<void> {
  data.lastModified = now();
  await writeJsonFile(PUBLIC_MUTES_FILE, data);
}

/**
 * Write private mutes to file
 */
export async function writePrivateMutesFile(data: MuteListData): Promise<void> {
  data.lastModified = now();
  await writeJsonFile(PRIVATE_MUTES_FILE, data);
}

/**
 * Save current browser state to files
 */
export async function saveToFile(): Promise<void> {
  const items = getMuteItems();

  const filterIds = (type: 'user' | 'thread', isPrivate: boolean): string[] =>
    items.filter(i => i.type === type && i.isPrivate === isPrivate).map(i => i.id);

  const publicUsers = filterIds('user', false);
  const privateUsers = filterIds('user', true);

  await writePublicMutesFile({
    items: publicUsers,
    eventIds: filterIds('thread', false),
    lastModified: now()
  });

  await writePrivateMutesFile({
    items: privateUsers,
    eventIds: filterIds('thread', true),
    lastModified: now()
  });

  logger.info('mutes.ts', `Saved to files: ${publicUsers.length} public, ${privateUsers.length} private users`);
}

/**
 * Convert file data to MuteItems
 */
function convertFileDataToMuteItems(publicData: MuteListData, privateData: MuteListData): MuteItem[] {
  const items: MuteItem[] = [];
  const timestamp = now();

  for (const pubkey of publicData.items) {
    items.push({ type: 'user', id: pubkey, isPrivate: false, addedAt: timestamp });
  }
  for (const pubkey of privateData.items) {
    items.push({ type: 'user', id: pubkey, isPrivate: true, addedAt: timestamp });
  }
  for (const eventId of publicData.eventIds) {
    items.push({ type: 'thread', id: eventId, isPrivate: false, addedAt: timestamp });
  }
  for (const eventId of privateData.eventIds) {
    items.push({ type: 'thread', id: eventId, isPrivate: true, addedAt: timestamp });
  }

  return items;
}

/**
 * Restore from files to browser storage
 * Protection: Won't overwrite browser data with empty file
 */
export async function restoreFromFile(): Promise<void> {
  const publicData = await readPublicMutesFile();
  const privateData = await readPrivateMutesFile();
  const items = convertFileDataToMuteItems(publicData, privateData);

  // Protection: Don't overwrite browser data with empty file
  if (items.length === 0) {
    const browserItems = getMuteItems();
    if (browserItems.length > 0) {
      logger.warn('mutes.ts', `Restore aborted: file empty but browser has ${browserItems.length} items`);
      throw new Error('File is empty. Use "Sync from Relays" to restore your mutes.');
    }
  }

  setMuteItems(items);
  logger.info('mutes.ts', `Restored from files: ${items.length} items`);
}

/**
 * Get all mutes from file (for RestoreListsService)
 */
export async function getFileMutes(): Promise<MuteItem[]> {
  const publicData = await readPublicMutesFile();
  const privateData = await readPrivateMutesFile();
  return convertFileDataToMuteItems(publicData, privateData);
}

// ============================================================
// RELAY OPERATIONS (NIP-51 kind:10000)
// ============================================================

/**
 * Fetch mutes from relays
 */
export async function fetchFromRelays(): Promise<FetchFromRelaysResult> {
  const pubkey = getCurrentUserPubkey();
  if (!pubkey) {
    return { items: [], relayContentWasEmpty: true };
  }

  try {
    // Fetch kind:10000 mute list
    const events = await fetchEvents([{
      authors: [pubkey],
      kinds: [10000],
      limit: 10
    }], 10000);

    if (events.length === 0) {
      logger.info('mutes.ts', 'No mute list found on relays');
      return { items: [], relayContentWasEmpty: true };
    }

    // Get the newest event
    const sortedEvents = events.sort((a, b) => b.created_at - a.created_at);
    const muteEvent = sortedEvents[0];
    if (!muteEvent) {
      return { items: [], relayContentWasEmpty: true };
    }

    const items: MuteItem[] = [];
    const timestamp = muteEvent.created_at;

    // Extract public mutes from p-tags (users) and e-tags (threads)
    for (const tag of muteEvent.tags) {
      if (tag[0] === 'p' && tag[1]) {
        items.push({
          type: 'user',
          id: tag[1],
          isPrivate: false,
          addedAt: timestamp
        });
      } else if (tag[0] === 'e' && tag[1]) {
        items.push({
          type: 'thread',
          id: tag[1],
          isPrivate: false,
          addedAt: timestamp
        });
      }
    }

    // Decrypt private mutes from content
    if (muteEvent.content && muteEvent.content.trim() !== '') {
      try {
        const privateTags = await decryptPrivateMutes(muteEvent.content, pubkey);
        for (const tag of privateTags) {
          if (tag[0] === 'p' && tag[1]) {
            items.push({
              type: 'user',
              id: tag[1],
              isPrivate: true,
              addedAt: timestamp
            });
          } else if (tag[0] === 'e' && tag[1]) {
            items.push({
              type: 'thread',
              id: tag[1],
              isPrivate: true,
              addedAt: timestamp
            });
          }
        }
      } catch (error) {
        logger.error('mutes.ts', `Failed to decrypt private mutes: ${error}`);
      }
    }

    // Deduplicate
    const deduped = deduplicateMuteItems(items);

    logger.info('mutes.ts', `Fetched from relays: ${deduped.length} items`);

    return {
      items: deduped,
      relayContentWasEmpty: items.length === 0
    };
  } catch (error) {
    logger.error('mutes.ts', `Failed to fetch from relays: ${error}`);
    return { items: [], relayContentWasEmpty: true };
  }
}

/**
 * Publish mutes to relays
 */
export async function publishToRelays(): Promise<void> {
  const user = requireAuth();
  const items = getMuteItems();

  // Separate public and private items
  const publicTags: string[][] = [];
  const privateTags: string[][] = [];

  for (const item of items) {
    const tagType = item.type === 'user' ? 'p' : 'e';
    const tag = [tagType, item.id];

    if (item.isPrivate) {
      privateTags.push(tag);
    } else {
      publicTags.push(tag);
    }
  }

  // Encrypt private content
  let content = '';
  if (privateTags.length > 0) {
    content = await encryptContent(JSON.stringify(privateTags), user.pubkey);
  }

  // Build event
  const event = {
    kind: 10000,
    created_at: now(),
    tags: publicTags,
    content,
    pubkey: user.pubkey
  };

  const signed = await signEvent(event);
  if (!signed) {
    throw new Error('Failed to sign mute list event');
  }

  await publishEvent(signed);
  logger.info('mutes.ts', `Published to relays: ${publicTags.length} public, ${privateTags.length} private`);
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

async function decryptPrivateMutes(ciphertext: string, pubkey: string): Promise<string[][]> {
  const plaintext = await decryptContent(ciphertext, pubkey);
  if (!plaintext) return [];

  try {
    return JSON.parse(plaintext);
  } catch {
    return [];
  }
}

function deduplicateMuteItems(items: MuteItem[]): MuteItem[] {
  const seen = new Map<string, MuteItem>();

  for (const item of items) {
    const key = `${item.type}:${item.id}:${item.isPrivate}`;
    if (!seen.has(key)) {
      seen.set(key, item);
    }
  }

  return Array.from(seen.values());
}

// ============================================================
// MUTE STORAGE ADAPTER (for AutoSyncService)
// ============================================================

/**
 * Storage adapter that provides string[] interface for ListSyncManager
 * Only exposes USER mutes (not threads) as string[] for compatibility
 */
export class MuteStorageAdapter extends BaseListStorageAdapter<string> {
  /**
   * Override setBrowserItems to handle string[] -> MuteItem[] conversion
   */
  override setBrowserItems(items: string[]): void {
    const existingItems = getMuteItems();
    const existingUserMap = new Map<string, MuteItem>(
      existingItems.filter(i => i.type === 'user').map(i => [i.id, i])
    );

    // Preserve threads, add/update users
    const threads = existingItems.filter(i => i.type === 'thread');
    const users = items.map(pubkey =>
      existingUserMap.get(pubkey) ?? { type: 'user' as const, id: pubkey, isPrivate: false, addedAt: now() }
    );

    setMuteItems([...threads, ...users]);
  }

  /**
   * Get browser items (returns only user pubkeys as string[])
   */
  override getBrowserItems(): string[] {
    return getAllMutedUsers();
  }

  protected getBrowserStorageKey(): string {
    return 'noornote_mutes_browser_v2';  // Legacy, for migration only
  }

  protected override getPerAccountStorageKey(): StorageKey {
    return StorageKeys.MUTES;
  }

  protected getLogPrefix(): string {
    return 'MuteStorageAdapter';
  }

  /**
   * Get unique ID for mute item (pubkey)
   */
  getItemId(item: string): string {
    return item;
  }

  /**
   * File Storage - read from file (returns only user pubkeys)
   */
  async getFileItems(): Promise<string[]> {
    try {
      const publicData = await readPublicMutesFile();
      const privateData = await readPrivateMutesFile();
      return [...publicData.items, ...privateData.items];
    } catch (error) {
      logger.error('MuteStorageAdapter', `Failed to read from file: ${error}`);
      throw error;
    }
  }

  /**
   * File Storage - save to file
   */
  async setFileItems(_items: string[]): Promise<void> {
    try {
      await saveToFile();
    } catch (error) {
      logger.error('MuteStorageAdapter', `Failed to write to file: ${error}`);
      throw error;
    }
  }

  /**
   * Relay Storage - fetch from relays (returns only user pubkeys)
   */
  async fetchFromRelays(): Promise<AdapterFetchResult<string>> {
    try {
      const result = await fetchFromRelays();
      const userPubkeys = result.items
        .filter(item => item.type === 'user')
        .map(item => item.id);

      return {
        items: userPubkeys,
        relayContentWasEmpty: result.relayContentWasEmpty
      };
    } catch (error) {
      logger.error('MuteStorageAdapter', `Failed to fetch from relays: ${error}`);
      throw error;
    }
  }

  /**
   * Relay Storage - publish to relays
   */
  async publishToRelays(_items: string[]): Promise<void> {
    try {
      await publishToRelays();
    } catch (error) {
      logger.error('MuteStorageAdapter', `Failed to publish to relays: ${error}`);
      throw error;
    }
  }
}

// ============================================================
// LEGACY ALIASES (for backward compatibility during migration)
// ============================================================

/**
 * MuteOrchestrator-compatible interface
 * This allows existing code to keep working while we migrate
 */
export const MuteOrchestrator = {
  getInstance: () => ({
    // Settings
    isPrivateMutesEnabled,
    setPrivateMutesEnabled,
    getEncryptionMethod,
    setEncryptionMethod,

    // User mutes
    getAllMutedUsers: (_pubkey?: string) => getAllMutedUsers(),
    getAllMutedUsersWithStatus: async (_pubkey?: string) => getAllMutedUsersWithStatus(),
    isMuted: async (pubkey: string, _userPubkey?: string) => isUserMuted(pubkey),
    muteUser: async (pubkey: string, isPrivate?: boolean) => muteUser(pubkey, isPrivate),
    unmuteUser: async (pubkey: string, isPrivate: boolean) => unmuteUser(pubkey, isPrivate),
    unmuteUserCompletely: async (pubkey: string) => unmuteUserCompletely(pubkey),

    // Thread mutes
    getAllMutedThreads,
    getAllMutedThreadsWithStatus: async () => getAllMutedThreadsWithStatus(),
    getAllMutedEventIds: () => getAllMutedThreads(), // Alias for thread IDs
    isThreadMuted,
    isEventMuted: async (eventId: string) => isThreadMuted(eventId), // Alias for thread mute check
    muteThread: async (eventId: string, isPrivate?: boolean) => muteThread(eventId, isPrivate),
    unmuteThread: async (eventId: string) => unmuteThread(eventId),
    isInMutedThread,

    // Temporary unmute
    temporaryUnmute,
    removeTemporaryUnmute,
    isTemporarilyUnmuted,
    clearTemporaryUnmutes,

    // Browser storage access
    getBrowserItems: () => getMuteItems(),

    // Relay operations
    fetchFromRelays,
    publishToRelays,

    // File operations
    saveToFile,
    restoreFromFile
  })
};

// ============================================================
// UI TYPES (for components below)
// ============================================================

interface MutedUser {
  pubkey: string;
  profile: UserProfile;
  status: MuteStatus;
}

interface MutedThreadItem {
  eventId: string;
  status: MuteStatus;
  content?: string;
}

interface MuteItemWithProfile {
  pubkey: string;
  status: MuteStatus;
  profile: UserProfile;
}

// ============================================================
// MUTE LIST VIEW (standalone view at /mutes)
// ============================================================

export class MuteListView extends View {
  private container: HTMLElement;
  private muteOrch: ReturnType<typeof MuteOrchestrator.getInstance>;
  private userProfileService: UserProfileService;
  private authService: AuthService;
  private listSyncManager: ListSyncManager<string>;
  private mutedUsers: MutedUser[] = [];
  private mutedThreads: MutedThreadItem[] = [];

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'mute-list-view';
    this.muteOrch = MuteOrchestrator.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.authService = AuthService.getInstance();

    const adapter = new MuteStorageAdapter();
    this.listSyncManager = new ListSyncManager(adapter);

    this.initializeBrowserStorage();
  }

  private async initializeBrowserStorage(): Promise<void> {
    const browserKey = 'noornote_mutes_browser_v2';
    const existingData = localStorage.getItem(browserKey);

    if (!existingData || existingData === '[]') {
      await this.listSyncManager.restoreFromFile().catch(() => {});
    }
  }

  public async render(): Promise<HTMLElement> {
    this.container.innerHTML = `
      <div class="mute-list-header">
        <h2>Mute List</h2>
        <p class="mute-list-description">Manage muted users and threads. Muted content won't appear in your timeline or notifications.</p>

        <div class="mute-list-actions">
          <div class="mute-list-actions__group">
            <button class="btn btn--small" id="sync-from-relays-btn">
              📥 Sync from Relays
            </button>
            <button class="btn btn--small" id="sync-to-relays-btn">
              📤 Sync to Relays
            </button>
          </div>

          <div class="mute-list-actions__group">
            <button class="btn btn--small btn--passive" id="save-to-file-btn">
              💾 Save to File
            </button>
            <button class="btn btn--small btn--passive" id="restore-from-file-btn">
              📂 Restore from File
            </button>
          </div>
        </div>
      </div>

      <div class="mute-list-content" id="mute-list-content">
        <div class="mute-list-loading">Loading mute list...</div>
      </div>
    `;

    this.loadMuteList();
    this.bindSyncButtons();
    this.bindFileButtons();

    return this.container;
  }

  private async loadMuteList(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.renderError('Please log in to view your mute list.');
      return;
    }

    try {
      const mutedUsersMap = await this.muteOrch.getAllMutedUsersWithStatus(currentUser.pubkey);
      this.mutedUsers = await Promise.all(
        Array.from(mutedUsersMap.entries()).map(async ([pubkey, status]) => ({
          pubkey,
          profile: await this.userProfileService.getUserProfile(pubkey),
          status
        }))
      );

      const mutedThreadsMap = await this.muteOrch.getAllMutedThreadsWithStatus();
      this.mutedThreads = Array.from(mutedThreadsMap.entries()).map(([eventId, status]) => ({
        eventId,
        status
      }));

      this.renderMuteList();
    } catch {
      this.renderError('Failed to load mute list. Please try again.');
    }
  }

  private renderMuteList(): void {
    const content = this.container.querySelector('#mute-list-content');
    if (!content) return;

    const hasUsers = this.mutedUsers.length > 0;
    const hasThreads = this.mutedThreads.length > 0;

    if (!hasUsers && !hasThreads) {
      content.innerHTML = `
        <div class="mute-list-empty">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 12l24 24M24 6v12a6 6 0 0 0 12 0M24 18v12a6 6 0 1 1-12 0V18a6 6 0 0 1 12 0" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <h3>No Muted Content</h3>
          <p>You haven't muted anyone or any threads yet.</p>
        </div>
      `;
      return;
    }

    let sectionsHtml = '';

    if (hasUsers) {
      sectionsHtml += this.renderUsersSection();
    }

    if (hasThreads) {
      sectionsHtml += this.renderThreadsSection();
    }

    content.innerHTML = sectionsHtml;

    setupUserMentionHandlers(content as HTMLElement);
    this.bindUnmuteListeners();
  }

  private renderUsersSection(): string {
    const userItems = this.mutedUsers
      .map(({ pubkey, profile, status }) => {
        const username = extractDisplayName(profile);
        const npub = hexToNpub(pubkey);
        const avatarUrl = profile.picture || '';
        const lockIcon = status.private ? '<span class="mute-list-item__badge mute-list-item__badge--private">🔒</span>' : '';

        return `
          <div class="mute-list-item" data-pubkey="${pubkey}">
            <div class="mute-list-item__info">
              <span class="user-mention" data-pubkey="${pubkey}">
                <a href="/profile/${npub}" class="mention-link mention-link--bg" data-profile-pubkey="${pubkey}">
                  <img class="profile-pic profile-pic--mini" src="${avatarUrl}" alt="${username}" />${username}</a></span>${lockIcon}
            </div>
            <button class="btn btn--passive btn--small unmute-user-btn" data-pubkey="${pubkey}">
              Unmute
            </button>
          </div>
        `;
      })
      .join('');

    return `
      <div class="mute-list-section">
        <div class="mute-list-section__header">
          <h3 class="mute-list-section__title">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="8" cy="5" r="3" stroke="currentColor" stroke-width="1.5"/>
              <path d="M2 14c0-3 2.5-5 6-5s6 2 6 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            Muted Users
            <span class="mute-list-section__count">${this.mutedUsers.length}</span>
          </h3>
        </div>
        <div class="mute-list-items">
          ${userItems}
        </div>
      </div>
    `;
  }

  private renderThreadsSection(): string {
    const threadItems = this.mutedThreads
      .map(({ eventId, status }) => {
        const lockIcon = status.private ? '<span class="mute-list-item__badge mute-list-item__badge--private">🔒</span>' : '';
        const shortId = eventId.slice(0, 8) + '...' + eventId.slice(-8);

        return `
          <div class="mute-list-item mute-list-item--thread" data-event-id="${eventId}">
            <div class="mute-list-item__info">
              <div class="mute-list-item__thread-icon">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M2 3h12a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 3v-3H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </div>
              <span class="mute-list-item__event-id" title="${eventId}">${shortId}${lockIcon}</span>
            </div>
            <button class="btn btn--passive btn--small unmute-thread-btn" data-event-id="${eventId}">
              Unmute
            </button>
          </div>
        `;
      })
      .join('');

    return `
      <div class="mute-list-section">
        <div class="mute-list-section__header">
          <h3 class="mute-list-section__title">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M2 3h12a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 3v-3H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            Muted Threads
            <span class="mute-list-section__count">${this.mutedThreads.length}</span>
          </h3>
          <p class="mute-list-section__description">Threads you muted to stop notifications from replies.</p>
        </div>
        <div class="mute-list-items">
          ${threadItems}
        </div>
      </div>
    `;
  }

  private renderError(message: string): void {
    const content = this.container.querySelector('#mute-list-content');
    if (!content) return;

    content.innerHTML = `
      <div class="mute-list-error">
        <p>${message}</p>
      </div>
    `;
  }

  private bindUnmuteListeners(): void {
    this.container.querySelectorAll('.unmute-user-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const pubkey = (e.currentTarget as HTMLElement).dataset.pubkey;
        if (pubkey) await this.handleUnmuteUser(pubkey);
      });
    });

    this.container.querySelectorAll('.unmute-thread-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const eventId = (e.currentTarget as HTMLElement).dataset.eventId;
        if (eventId) await this.handleUnmuteThread(eventId);
      });
    });
  }

  private bindSyncButtons(): void {
    this.bindButton('#sync-from-relays-btn', () => this.handleSyncFromRelays());
    this.bindButton('#sync-to-relays-btn', () => this.handleSyncToRelays());
  }

  private bindFileButtons(): void {
    this.bindButton('#save-to-file-btn', () => this.handleSaveToFile());
    this.bindButton('#restore-from-file-btn', () => this.handleRestoreFromFile());
  }

  private bindButton(selector: string, handler: () => Promise<void>): void {
    const btn = this.container.querySelector(selector);
    if (btn) {
      btn.addEventListener('click', handler);
    }
  }

  private async handleSyncFromRelays(): Promise<void> {
    try {
      ToastService.show('Fetching from relays...', 'info');
      const result = await this.listSyncManager.syncFromRelays();

      if (result.requiresConfirmation) {
        const modal = new SyncConfirmationModal({
          listType: 'Mute List',
          added: result.diff.added,
          removed: result.diff.removed,
          getDisplayName: (pubkey: string) => {
            const user = this.mutedUsers.find(u => u.pubkey === pubkey);
            return user ? extractDisplayName(user.profile) : pubkey.slice(0, 8) + '...';
          },
          onKeep: async () => {
            await this.listSyncManager.applySyncFromRelays('merge', result.relayItems, result.relayContentWasEmpty);
            ToastService.show(`Merged ${result.diff.added.length} new mutes (kept ${result.diff.removed.length} local mutes)`, 'success');
            await this.loadMuteList();
          },
          onDelete: async () => {
            await this.listSyncManager.applySyncFromRelays('overwrite', result.relayItems, result.relayContentWasEmpty);
            ToastService.show(`Synced from relays (added ${result.diff.added.length}, removed ${result.diff.removed.length})`, 'success');
            await this.loadMuteList();
          }
        });
        modal.show();
      } else {
        await this.listSyncManager.applySyncFromRelays('merge', result.relayItems, result.relayContentWasEmpty);
        ToastService.show(`Synced ${result.diff.added.length} new mute${result.diff.added.length > 1 ? 's' : ''} from relays`, 'success');
        await this.loadMuteList();
      }
    } catch {
      ToastService.show('Failed to sync from relays', 'error');
    }
  }

  private async handleSyncToRelays(): Promise<void> {
    try {
      ToastService.show('Publishing to relays...', 'info');
      await this.listSyncManager.syncToRelays();
      ToastService.show('Mute list published successfully', 'success');
    } catch {
      ToastService.show('Failed to publish to relays', 'error');
    }
  }

  private async handleSaveToFile(): Promise<void> {
    try {
      ToastService.show('Saving to file...', 'info');
      await this.listSyncManager.saveToFile();
      ToastService.show('Saved to local file', 'success');
    } catch {
      ToastService.show('Failed to save to file', 'error');
    }
  }

  private async handleRestoreFromFile(): Promise<void> {
    try {
      ToastService.show('Reading from file...', 'info');
      const result = await this.listSyncManager.syncFromFile();

      if (result.requiresConfirmation) {
        const modal = new SyncConfirmationModal({
          listType: 'Mute List (File)',
          added: result.diff.added,
          removed: result.diff.removed,
          getDisplayName: (pubkey: string) => {
            const user = this.mutedUsers.find(u => u.pubkey === pubkey);
            return user ? extractDisplayName(user.profile) : pubkey.slice(0, 8) + '...';
          },
          onKeep: async () => {
            await this.listSyncManager.applySyncFromFile('merge', result.fileItems);
            ToastService.show(`Merged ${result.diff.added.length} from file (kept ${result.diff.removed.length} local)`, 'success');
            await this.loadMuteList();
          },
          onDelete: async () => {
            await this.listSyncManager.applySyncFromFile('overwrite', result.fileItems);
            ToastService.show(`Restored from file (added ${result.diff.added.length}, removed ${result.diff.removed.length})`, 'success');
            await this.loadMuteList();
          }
        });
        modal.show();
      } else if (result.diff.added.length > 0) {
        await this.listSyncManager.applySyncFromFile('overwrite', result.fileItems);
        ToastService.show(`Restored ${result.diff.added.length} mute${result.diff.added.length > 1 ? 's' : ''} from file`, 'success');
        await this.loadMuteList();
      } else {
        ToastService.show('File is identical to current list', 'info');
      }
    } catch (error) {
      ToastService.show(`Failed to restore from file: ${error}`, 'error');
    }
  }

  private async handleUnmuteUser(pubkey: string): Promise<void> {
    try {
      await this.muteOrch.unmuteUserCompletely(pubkey);
      ToastService.show('User unmuted', 'success');

      this.mutedUsers = this.mutedUsers.filter(u => u.pubkey !== pubkey);
      this.renderMuteList();

      const { FeedOrchestrator } = await import('../services/orchestration/FeedOrchestrator');
      const { NotificationsOrchestrator } = await import('../services/orchestration/NotificationsOrchestrator');

      await Promise.all([
        FeedOrchestrator.getInstance().refreshMutedUsers(),
        NotificationsOrchestrator.getInstance().refreshMutedUsers()
      ]);

      EventBus.getInstance().emit('mute:updated', {});
    } catch {
      ToastService.show('Failed to unmute user', 'error');
    }
  }

  private async handleUnmuteThread(eventId: string): Promise<void> {
    try {
      await this.muteOrch.unmuteThread(eventId);
      ToastService.show('Thread unmuted', 'success');

      this.mutedThreads = this.mutedThreads.filter(t => t.eventId !== eventId);
      this.renderMuteList();

      const eventBus = EventBus.getInstance();
      eventBus.emit('mute:thread:updated', { eventId });
      eventBus.emit('mute:updated', {});
    } catch {
      ToastService.show('Failed to unmute thread', 'error');
    }
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.remove();
  }
}

// ============================================================
// MUTE LIST MANAGER (sidebar manager in secondary-content)
// ============================================================

export class MuteListManager extends BaseListManager<string, MuteItemWithProfile> {
  private muteOrch: ReturnType<typeof MuteOrchestrator.getInstance>;
  private userProfileService: UserProfileService;
  private router: Router;
  private mutedThreads: MutedThreadItem[] = [];

  constructor(containerElement: HTMLElement) {
    const adapter = new MuteStorageAdapter();
    const listSyncManager = new ListSyncManager(adapter);

    super(containerElement, listSyncManager);

    this.muteOrch = MuteOrchestrator.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.router = Router.getInstance();

    this.eventBus.on('user:login', () => {
      this.mutedThreads = [];
    });
  }

  protected getEventName(): string {
    return 'mute:updated';
  }

  protected getTabDataAttribute(): string {
    return 'list-mutes';
  }

  protected getListContainerClass(): string {
    return 'mutes-list';
  }

  protected getListType(): string {
    return 'Mute List';
  }

  protected async getDisplayNameForSync(pubkey: string): Promise<string> {
    const profile = await this.userProfileService.getUserProfile(pubkey);
    return extractDisplayName(profile);
  }

  protected async getAllItemsWithProfiles(): Promise<MuteItemWithProfile[]> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const allMutedPubkeys = await this.muteOrch.getAllMutedUsers();
    const muteStatus = await this.muteOrch.getAllMutedUsersWithStatus();

    const mutesWithProfiles: MuteItemWithProfile[] = await Promise.all(
      allMutedPubkeys.map(async (pubkey) => {
        const status = muteStatus.get(pubkey);
        return {
          pubkey,
          status: status || { public: true, private: false, any: true },
          profile: await this.userProfileService.getUserProfile(pubkey)
        };
      })
    );

    const threadsMap = await this.muteOrch.getAllMutedThreadsWithStatus();
    const threadEntries = Array.from(threadsMap.entries());

    if (threadEntries.length > 0) {
      const noteService = NoteService.getInstance();
      const eventIds = threadEntries.map(([id]) => id);

      try {
        const events = await noteService.getNotes(eventIds);

        this.mutedThreads = threadEntries.map(([eventId, status]) => {
          const event = events.get(eventId);
          const thread: MutedThreadItem = { eventId, status };
          if (event?.content !== undefined) thread.content = event.content;
          return thread;
        });
      } catch {
        this.mutedThreads = threadEntries.map(([eventId, status]) => ({
          eventId,
          status
        }));
      }
    } else {
      this.mutedThreads = [];
    }

    return mutesWithProfiles;
  }

  public override async renderListTab(content: HTMLElement): Promise<void> {
    content.innerHTML = `
      <div class="list-loading">
        <div class="spinner"></div>
        <p>Loading mute list...</p>
      </div>
    `;

    try {
      this.allItemsWithProfiles = await this.getAllItemsWithProfiles();

      const hasUsers = this.allItemsWithProfiles.length > 0;
      const hasThreads = this.mutedThreads.length > 0;

      if (!hasUsers && !hasThreads) {
        content.innerHTML = this.renderControlButtons() + `
          <div class="list-empty">
            <p>No muted users or threads</p>
          </div>
        ` + this.renderControlButtons();
        this.bindSyncButtons(content);
        return;
      }

      let html = this.renderControlButtons();

      if (hasUsers) {
        html += `
          <div class="mute-section">
            <div class="mute-section__header">
              <span class="mute-section__title">Muted Users</span>
              <span class="badge">${this.allItemsWithProfiles.length}</span>
            </div>
            <div class="mutes-list mutes-list--users"></div>
          </div>
        `;
      }

      if (hasThreads) {
        html += `
          <div class="mute-section">
            <div class="mute-section__header">
              <span class="mute-section__title">Muted Threads</span>
              <span class="badge">${this.mutedThreads.length}</span>
            </div>
            <div class="mutes-list mutes-list--threads"></div>
          </div>
        `;
      }

      html += this.renderControlButtons();

      content.innerHTML = html;

      this.bindSyncButtons(content);

      if (hasUsers) {
        const usersContainer = content.querySelector('.mutes-list--users');
        if (usersContainer) {
          this.renderBatch(usersContainer as HTMLElement, this.allItemsWithProfiles);
        }
      }

      if (hasThreads) {
        const threadsContainer = content.querySelector('.mutes-list--threads');
        if (threadsContainer) {
          this.renderThreadsBatch(threadsContainer as HTMLElement, this.mutedThreads);
        }
      }

    } catch (error) {
      console.error('Failed to load mute list:', error);
      content.innerHTML = `
        <div class="list-error">
          <p>Failed to load mute list</p>
        </div>
      `;
    }
  }

  protected renderBatch(listElement: HTMLElement, batch: MuteItemWithProfile[]): void {
    for (const item of batch) {
      const username = extractDisplayName(item.profile);
      const npub = hexToNpub(item.pubkey);
      const avatarUrl = item.profile?.picture || '';

      const muteItemDiv = document.createElement('div');
      muteItemDiv.className = 'ui-list__item mute-item';
      muteItemDiv.dataset.pubkey = item.pubkey;
      muteItemDiv.innerHTML = `
        <div class="mute-item__content-wrapper">
          <div class="mute-item__avatar">
            <img class="profile-pic profile-pic--medium" src="${avatarUrl}" alt="${username}" />
          </div>
          <div class="mute-item__info">
            <div class="mute-item__username">
              ${this.escapeHtml(username)}
              ${item.status.private ? '<span class="private-badge">🔒 Private</span>' : ''}
            </div>
          </div>
        </div>
        <button class="mute-item__unmute-btn btn btn--passive btn--small" data-pubkey="${item.pubkey}">
          Unmute
        </button>
      `;

      const contentWrapper = muteItemDiv.querySelector('.mute-item__content-wrapper');
      contentWrapper?.addEventListener('click', () => {
        this.router.navigate(`/profile/${npub}`);
      });

      const unmuteBtn = muteItemDiv.querySelector('.mute-item__unmute-btn');
      unmuteBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.handleRemoveItem(item, muteItemDiv);
      });

      const sentinel = listElement.querySelector('.infinite-scroll-sentinel');
      if (sentinel) {
        listElement.insertBefore(muteItemDiv, sentinel);
      } else {
        listElement.appendChild(muteItemDiv);
      }
    }
  }

  private renderThreadsBatch(listElement: HTMLElement, threads: MutedThreadItem[]): void {
    for (const thread of threads) {
      const truncatedContent = thread.content
        ? (thread.content.length > 80 ? thread.content.slice(0, 80) + '...' : thread.content)
        : 'Content unavailable';

      const threadDiv = document.createElement('div');
      threadDiv.className = 'ui-list__item mute-item mute-item--thread';
      threadDiv.dataset.eventId = thread.eventId;
      threadDiv.innerHTML = `
        <div class="mute-item__content-wrapper">
          <div class="mute-item__thread-icon">
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M2 3h12a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3 3v-3H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="mute-item__info">
            <div class="mute-item__thread-content" title="${this.escapeHtml(thread.content || '')}">
              ${this.escapeHtml(truncatedContent)}
              ${thread.status.private ? '<span class="private-badge">🔒</span>' : ''}
            </div>
          </div>
        </div>
        <button class="mute-item__unmute-btn btn btn--passive btn--small" data-event-id="${thread.eventId}">
          Unmute
        </button>
      `;

      const contentWrapper = threadDiv.querySelector('.mute-item__content-wrapper');
      contentWrapper?.addEventListener('click', () => {
        this.router.navigate(`/note/${thread.eventId}`);
      });

      const unmuteBtn = threadDiv.querySelector('.mute-item__unmute-btn');
      unmuteBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.handleUnmuteThread(thread.eventId, threadDiv);
      });

      listElement.appendChild(threadDiv);
    }
  }

  protected async handleRemoveItem(item: MuteItemWithProfile, itemElement: HTMLElement): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return;

    try {
      await this.muteOrch.unmuteUserCompletely(item.pubkey);
      ToastService.show('User unmuted', 'success');

      itemElement.remove();

      this.allItemsWithProfiles = this.allItemsWithProfiles.filter(m => m.pubkey !== item.pubkey);

      const { FeedOrchestrator } = await import('../services/orchestration/FeedOrchestrator');
      const { NotificationsOrchestrator } = await import('../services/orchestration/NotificationsOrchestrator');

      const feedOrch = FeedOrchestrator.getInstance();
      const notifOrch = NotificationsOrchestrator.getInstance();

      await Promise.all([
        feedOrch.refreshMutedUsers(),
        notifOrch.refreshMutedUsers()
      ]);

      this.eventBus.emit('mute:updated', {});
    } catch (error) {
      console.error('Failed to unmute user:', error);
      ToastService.show('Failed to unmute user', 'error');
    }
  }

  private async handleUnmuteThread(eventId: string, itemElement: HTMLElement): Promise<void> {
    try {
      await this.muteOrch.unmuteThread(eventId);
      ToastService.show('Thread unmuted', 'success');

      itemElement.remove();

      this.mutedThreads = this.mutedThreads.filter(t => t.eventId !== eventId);

      this.eventBus.emit('mute:thread:updated', { eventId });
      this.eventBus.emit('mute:updated', {});
    } catch (error) {
      console.error('Failed to unmute thread:', error);
      ToastService.show('Failed to unmute thread', 'error');
    }
  }

  public handleTabSwitch(tabName: string, content: HTMLElement): void {
    if (tabName === 'mutes') {
      this.renderListTab(content).catch(err => {
        console.error('Failed to render mutes tab:', err);
      });
    }
  }
}

// ============================================================
// PROFILE MUTE MANAGER (mute UI on profile pages)
// ============================================================

export class ProfileMuteManager {
  private authService: AuthService;
  private muteOrch: ReturnType<typeof MuteOrchestrator.getInstance>;
  private userProfileService: UserProfileService;
  private targetPubkey: string;
  private eventListenersAttached: boolean = false;

  constructor(targetPubkey: string) {
    this.targetPubkey = targetPubkey;
    this.authService = AuthService.getInstance();
    this.muteOrch = MuteOrchestrator.getInstance();
    this.userProfileService = UserProfileService.getInstance();
  }

  public async checkMuteStatus(): Promise<{ public: boolean; private: boolean }> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      return { public: false, private: false };
    }

    return await this.muteOrch.isMuted(this.targetPubkey, currentUser.pubkey);
  }

  public renderMuteButton(): string {
    const currentUser = this.authService.getCurrentUser();

    if (!currentUser || this.targetPubkey === currentUser.pubkey) {
      return '';
    }

    const isPrivateMutesEnabled = this.muteOrch.isPrivateMutesEnabled();

    if (isPrivateMutesEnabled) {
      return `
        <div class="mute-dropdown-container">
          <button class="btn btn--passive mute-btn-dropdown" id="mute-btn-dropdown">
            Mute
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-left: 4px;">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <div class="mute-dropdown-menu" id="mute-dropdown-menu">
            <button class="mute-dropdown-item" data-action="mute-public">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
              </svg>
              Mute publicly
            </button>
            <button class="mute-dropdown-item" data-action="mute-private">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
              Mute privately
            </button>
          </div>
        </div>
      `;
    } else {
      return `
        <button class="btn btn--passive mute-btn" data-action="mute">
          Mute
        </button>
      `;
    }
  }

  public setupMuteButton(container: HTMLElement, onMuted: () => void): void {
    if (this.eventListenersAttached) return;
    this.eventListenersAttached = true;

    const simpleMuteBtn = container.querySelector('.mute-btn[data-action="mute"]');
    if (simpleMuteBtn) {
      simpleMuteBtn.addEventListener('click', async () => {
        await this.handleMute('public', onMuted);
      });
      return;
    }

    const dropdownBtn = container.querySelector('#mute-btn-dropdown');
    const dropdownMenu = container.querySelector('#mute-dropdown-menu');

    if (!dropdownBtn || !dropdownMenu) return;

    dropdownBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdownMenu.classList.toggle('show');
    });

    document.addEventListener('click', () => {
      dropdownMenu.classList.remove('show');
    });

    const dropdownItems = container.querySelectorAll('.mute-dropdown-item');
    dropdownItems.forEach(item => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = (item as HTMLElement).dataset.action;

        dropdownMenu.classList.remove('show');

        if (action === 'mute-public') {
          await this.handleMute('public', onMuted);
        } else if (action === 'mute-private') {
          await this.handleMute('private', onMuted);
        }
      });
    });
  }

  private async handleMute(type: 'public' | 'private', onMuted: () => void): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return;

    try {
      await this.muteOrch.muteUser(this.targetPubkey, type === 'private');
      ToastService.show(`User muted ${type === 'private' ? 'privately' : 'publicly'}`, 'success');

      onMuted();
    } catch (error) {
      console.error('Failed to mute user:', error);
      ToastService.show('Failed to mute user', 'error');
    }
  }

  public async renderMutedProfile(escapeHtml: (text: string) => string): Promise<string> {
    const profile = await this.userProfileService.getUserProfile(this.targetPubkey);
    const username = profile.display_name || profile.name || profile.username || this.targetPubkey.slice(0, 8);

    return `
      <div class="profile-muted">
        <div class="profile-muted__content">
          <span class="profile-muted__icon">🔇</span>
          <h2>Profile of a user you have muted</h2>
          <p>You've muted ${escapeHtml(username)}.</p>
          <div class="profile-muted__actions">
            <button class="btn profile-muted__unmute" data-pubkey="${this.targetPubkey}">
              Unmute
            </button>
          </div>
        </div>
      </div>
    `;
  }

  public setupUnmuteButton(container: HTMLElement, onUnmuted: () => void): void {
    const unmuteBtn = container.querySelector('.profile-muted__unmute');

    if (unmuteBtn) {
      unmuteBtn.addEventListener('click', async () => {
        const currentUser = this.authService.getCurrentUser();
        if (!currentUser) return;

        try {
          await this.muteOrch.unmuteUserCompletely(this.targetPubkey);
          ToastService.show('User unmuted', 'success');

          onUnmuted();
        } catch (error) {
          console.error('Failed to unmute user:', error);
          ToastService.show('Failed to unmute user', 'error');
        }
      });
    }
  }
}
