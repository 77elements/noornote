/**
 * follows.ts - ALL follow logic in ONE file
 *
 * Contains:
 * - Data types (FollowItem)
 * - Browser storage (localStorage via PerAccountLocalStorage)
 * - File storage (Tauri) - separate public/private files
 * - Relay operations (NIP-02 kind:3 + NIP-51 kind:30000 for private)
 * - FollowStorageAdapter (for AutoSyncService/ListSyncManager)
 * - FollowOrchestrator (legacy alias for backward compatibility)
 * - ProfileFollowManager (profile follow/unfollow UI)
 * - FollowListManager (sidebar list UI)
 *
 * NOTE: This is the MOST CRITICAL list - the timeline depends on it!
 *
 * GOAL: Claude can understand and fix follow bugs without navigating between files.
 */

import { StorageKeys, now, deduplicateByPubkey } from './storage';
import { readJsonFile, writeJsonFile, uploadJsonFile } from './file';
import { fetchEvents, publishEvent, signEvent, requireAuth, getCurrentUserPubkey } from './relays';
import { PerAccountLocalStorage } from '../services/PerAccountLocalStorage';
import { SystemLogger } from '../components/system/SystemLogger';
import { EventBus } from '../services/EventBus';
import { AuthService } from '../services/AuthService';
import { ToastService } from '../services/ToastService';
import { AppState } from '../services/AppState';
import { SyncConfirmationModal } from '../components/modals/SyncConfirmationModal';
import { switchTabWithContent } from '../helpers/TabsHelper';
import { renderListSyncButtons, bindSwitchSyncModeLink } from '../helpers/ListSyncMode';
import { PlatformService } from '../services/PlatformService';
import { UserProfileService } from '../services/UserProfileService';
import { MutualService } from '../services/MutualService';
import { MutualChangeDetector } from '../services/MutualChangeDetector';
import { MutualChangeStorage } from './MutualChangeStorage';
import { ZapStatsService } from '../services/ZapStatsService';
import { Router } from '../services/Router';
import { hexToNpub } from '../helpers/nip19';
import { extractDisplayName } from '../helpers/extractDisplayName';
import { InfiniteScroll } from '../components/ui/InfiniteScroll';
import { ProgressBarHelper } from '../helpers/ProgressBarHelper';
import { ArticleNotificationService } from '../services/ArticleNotificationService';
import { renderUserMention, setupUserMentionHandlers } from '../helpers/UserMentionHelper';
import type { UserProfile } from '../services/UserProfileService';

const logger = SystemLogger.getInstance();
const eventBus = EventBus.getInstance();

// ============================================================
// TYPES
// ============================================================

/**
 * Follow item with NIP-02 metadata
 */
export interface FollowItem {
  id: string;          // Same as pubkey (for BaseListItem compatibility)
  pubkey: string;
  relay?: string;      // NIP-02: Optional relay hint
  petname?: string;    // NIP-02: Optional local nickname
  addedAt?: number;    // Timestamp when added
  isPrivate?: boolean; // True if this is a private follow
}

/**
 * File storage format
 */
export interface FollowListData {
  items: FollowItem[];
  lastModified: number;
}

/**
 * Result from fetching follows from relays
 */
export interface FetchFromRelaysResult {
  items: FollowItem[];
  relayContentWasEmpty: boolean;
  decryptionFailed?: boolean;
}

/**
 * Sync diff between browser and relay/file
 */
interface SyncDiff {
  added: FollowItem[];
  removed: FollowItem[];
  unchanged: FollowItem[];
}

/**
 * Result from sync from relays (phase 1)
 */
interface SyncFromRelaysResult {
  requiresConfirmation: boolean;
  diff: SyncDiff;
  relayItems: FollowItem[];
  relayContentWasEmpty: boolean;
}

/**
 * Result from sync from file (phase 1)
 */
interface SyncFromFileResult {
  requiresConfirmation: boolean;
  diff: SyncDiff;
  fileItems: FollowItem[];
}

/**
 * Follow item with profile (for UI rendering)
 */
interface FollowItemWithProfile {
  pubkey: string;
  relay?: string;
  petname?: string;
  addedAt?: number;
  profile: UserProfile;
  isPrivate: boolean;
  isMutual: boolean;
}

// ============================================================
// BROWSER STORAGE (localStorage via PerAccountLocalStorage)
// ============================================================

const storage = PerAccountLocalStorage.getInstance();

/**
 * Read follow items from browser storage
 */
export function getFollowItems(): FollowItem[] {
  return storage.get<FollowItem[]>(StorageKeys.FOLLOWS, []);
}

/**
 * Write follow items to browser storage
 */
export function setFollowItems(items: FollowItem[]): void {
  storage.set(StorageKeys.FOLLOWS, items);
  eventBus.emit('follow:updated', {});
}

/**
 * Clear follow items from browser storage
 */
export function clearFollowItems(): void {
  storage.remove(StorageKeys.FOLLOWS);
}

/**
 * Get all followed pubkeys
 */
export function getAllFollowedPubkeys(): string[] {
  return getFollowItems().map(item => item.pubkey);
}

/**
 * Get all follows with their public/private status
 */
export function getAllFollowsWithStatus(): Map<string, { public: boolean; private: boolean }> {
  const items = getFollowItems();
  const statusMap = new Map<string, { public: boolean; private: boolean }>();

  for (const item of items) {
    const existing = statusMap.get(item.pubkey);
    const isPrivate = item.isPrivate === true;

    if (existing) {
      existing.private = existing.private || isPrivate;
      existing.public = existing.public || !isPrivate;
    } else {
      statusMap.set(item.pubkey, { public: !isPrivate, private: isPrivate });
    }
  }

  return statusMap;
}

/**
 * Check if a user is followed
 */
export function isFollowing(pubkey: string): { public: boolean; private: boolean } {
  const items = getFollowItems().filter(item => item.pubkey === pubkey);

  if (items.length === 0) {
    return { public: false, private: false };
  }

  return {
    public: items.some(item => !item.isPrivate),
    private: items.some(item => item.isPrivate === true)
  };
}

/**
 * Follow a user
 */
export function followUser(pubkey: string, isPrivate: boolean = false, relay?: string, petname?: string): void {
  requireAuth();

  const items = getFollowItems();

  // Check if already following
  const existingIndex = items.findIndex(item => item.pubkey === pubkey);

  if (existingIndex !== -1) {
    // Update existing follow
    const existing = items[existingIndex];
    if (existing) {
      existing.isPrivate = isPrivate;
      if (relay !== undefined) existing.relay = relay;
      if (petname !== undefined) existing.petname = petname;
    }
  } else {
    // Add new follow
    const newItem: FollowItem = {
      id: pubkey,
      pubkey,
      isPrivate,
      addedAt: now()
    };
    if (relay) newItem.relay = relay;
    if (petname) newItem.petname = petname;
    items.push(newItem);
  }

  setFollowItems(items);
  logger.info('follows.ts', `Followed user ${pubkey.slice(0, 8)}... (${isPrivate ? 'private' : 'public'})`);
}

/**
 * Unfollow a user
 */
export function unfollowUser(pubkey: string): void {
  requireAuth();

  const items = getFollowItems();
  const filtered = items.filter(item => item.pubkey !== pubkey);

  if (filtered.length !== items.length) {
    setFollowItems(filtered);
    logger.info('follows.ts', `Unfollowed user ${pubkey.slice(0, 8)}...`);
  }
}

// ============================================================
// SETTINGS
// ============================================================

const PRIVATE_FOLLOWS_FLAG_KEY = 'noornote_nip51_private_follows_enabled';
const MIGRATION_FLAG_KEY = 'noornote_follows_file_storage_migrated';

/**
 * Check if private follows feature is enabled
 */
export function isPrivateFollowsEnabled(): boolean {
  return localStorage.getItem(PRIVATE_FOLLOWS_FLAG_KEY) === 'true';
}

/**
 * Set private follows feature flag
 */
export function setPrivateFollowsEnabled(enabled: boolean): void {
  localStorage.setItem(PRIVATE_FOLLOWS_FLAG_KEY, enabled.toString());
}

/**
 * Check if migrated to file storage
 */
export function isMigratedToFileStorage(): boolean {
  return localStorage.getItem(MIGRATION_FLAG_KEY) === 'true';
}

/**
 * Set migration flag
 */
export function setMigratedToFileStorage(): void {
  localStorage.setItem(MIGRATION_FLAG_KEY, 'true');
}

// ============================================================
// FILE STORAGE (Tauri)
// ============================================================

const PUBLIC_FOLLOWS_FILE = 'follows-public.json';
const PRIVATE_FOLLOWS_FILE = 'follows-private.json';

function createEmptyFollowListData(): FollowListData {
  return {
    items: [],
    lastModified: now()
  };
}

/**
 * Read public follows from file
 */
export async function readPublicFollowsFile(): Promise<FollowListData> {
  return await readJsonFile<FollowListData>(PUBLIC_FOLLOWS_FILE, createEmptyFollowListData());
}

/**
 * Read private follows from file
 */
export async function readPrivateFollowsFile(): Promise<FollowListData> {
  return await readJsonFile<FollowListData>(PRIVATE_FOLLOWS_FILE, createEmptyFollowListData());
}

/**
 * Write public follows to file
 */
export async function writePublicFollowsFile(data: FollowListData): Promise<void> {
  data.lastModified = now();
  await writeJsonFile(PUBLIC_FOLLOWS_FILE, data);
}

/**
 * Write private follows to file
 */
export async function writePrivateFollowsFile(data: FollowListData): Promise<void> {
  data.lastModified = now();
  await writeJsonFile(PRIVATE_FOLLOWS_FILE, data);
}

/**
 * Save current browser state to files
 */
export async function saveToFile(): Promise<void> {
  const items = getFollowItems();

  const publicFollows = items.filter(i => !i.isPrivate);
  const privateFollows = items.filter(i => i.isPrivate === true);

  await writePublicFollowsFile({
    items: publicFollows,
    lastModified: now()
  });

  await writePrivateFollowsFile({
    items: privateFollows,
    lastModified: now()
  });

  logger.info('follows.ts', `Saved to files: ${publicFollows.length} public, ${privateFollows.length} private`);
}

/**
 * Restore from files to browser storage
 */
export async function restoreFromFile(): Promise<void> {
  const publicData = await readPublicFollowsFile();
  const privateData = await readPrivateFollowsFile();

  // Mark items with their privacy status and deduplicate
  const allItems = deduplicateByPubkey([
    ...publicData.items.map(item => ({ ...item, isPrivate: false })),
    ...privateData.items.map(item => ({ ...item, isPrivate: true }))
  ]);

  setFollowItems(allItems);
  logger.info('follows.ts', `Restored from files: ${allItems.length} items`);
}

/**
 * Get all follows from file (for RestoreListsService)
 */
export async function getFileFollows(): Promise<FollowItem[]> {
  const publicData = await readPublicFollowsFile();
  const privateData = await readPrivateFollowsFile();

  return deduplicateByPubkey([
    ...publicData.items.map(item => ({ ...item, isPrivate: false })),
    ...privateData.items.map(item => ({ ...item, isPrivate: true }))
  ]);
}

// ============================================================
// RELAY OPERATIONS (NIP-02 kind:3 + NIP-51 kind:30000)
// ============================================================

/**
 * Fetch follows from relays
 * - kind:3 for public follows (NIP-02)
 * - kind:30000 with d-tag "private-follows" for private follows (NIP-51)
 */
export async function fetchFromRelays(): Promise<FetchFromRelaysResult> {
  const pubkey = getCurrentUserPubkey();
  if (!pubkey) {
    return { items: [], relayContentWasEmpty: true };
  }

  try {
    // Fetch both kind:3 (public) and kind:30000 (private) events
    const [kind3Events, kind30000Events] = await Promise.all([
      fetchEvents([{
        authors: [pubkey],
        kinds: [3],
        limit: 1
      }], 10000),
      isPrivateFollowsEnabled()
        ? fetchEvents([{
            authors: [pubkey],
            kinds: [30000],
            '#d': ['private-follows'],
            limit: 1
          }], 10000)
        : Promise.resolve([])
    ]);

    const items: FollowItem[] = [];
    let decryptionFailed = false;

    // Extract public follows from kind:3 tags (most recent event)
    const kind3Event = kind3Events.reduce<typeof kind3Events[0] | undefined>(
      (latest, ev) => (!latest || ev.created_at > latest.created_at ? ev : latest),
      undefined
    );
    if (kind3Event) {
      for (const tag of kind3Event.tags) {
        if (tag[0] === 'p' && tag[1]) {
          items.push({
            id: tag[1],
            pubkey: tag[1],
            addedAt: kind3Event.created_at,
            isPrivate: false,
            ...(tag[2] && { relay: tag[2] }),
            ...(tag[3] && { petname: tag[3] })
          });
        }
      }
    }

    // Extract private follows from kind:30000 content (most recent event)
    if (isPrivateFollowsEnabled()) {
      const kind30000Event = kind30000Events.reduce<typeof kind30000Events[0] | undefined>(
        (latest, ev) => (!latest || ev.created_at > latest.created_at ? ev : latest),
        undefined
      );
      if (kind30000Event?.content) {
        try {
          const { decryptPrivateFollows } = await import('../helpers/decryptPrivateFollows');
          const privatePubkeys = await decryptPrivateFollows(kind30000Event.content, pubkey);
          const timestamp = kind30000Event.created_at;

          for (const pk of privatePubkeys) {
            items.push({
              id: pk,
              pubkey: pk,
              addedAt: timestamp,
              isPrivate: true
            });
          }
        } catch (error) {
          logger.error('follows.ts', `Failed to decrypt private follows: ${error}`);
          decryptionFailed = true;
        }
      }
    }

    // Deduplicate
    const deduped = deduplicateByPubkey(items);

    logger.info('follows.ts', `Fetched from relays: ${deduped.length} items`);

    return {
      items: deduped,
      relayContentWasEmpty: items.length === 0,
      decryptionFailed
    };
  } catch (error) {
    logger.error('follows.ts', `Failed to fetch from relays: ${error}`);
    return { items: [], relayContentWasEmpty: true };
  }
}

/**
 * Publish follows to relays
 * - kind:3 for public follows (tags)
 * - kind:30000 for private follows (encrypted content)
 */
export async function publishToRelays(): Promise<void> {
  const user = requireAuth();
  const items = getFollowItems();

  // Separate public and private
  const publicItems = items.filter(item => !item.isPrivate);
  const privateItems = items.filter(item => item.isPrivate === true);

  // Build kind:3 tags (p, pubkey, relay?, petname?)
  const publicTags: string[][] = publicItems.map(item => [
    'p',
    item.pubkey,
    ...(item.relay ? [item.relay] : []),
    ...(item.petname ? [item.petname] : [])
  ]);

  // Build and publish kind:3 event (public follows)
  const kind3Event = {
    kind: 3,
    created_at: now(),
    tags: publicTags,
    content: '', // Empty content for standard NIP-02
    pubkey: user.pubkey
  };

  const signedKind3 = await signEvent(kind3Event);
  if (!signedKind3) {
    throw new Error('Failed to sign kind:3 follow list event');
  }

  await publishEvent(signedKind3);
  logger.info('follows.ts', `Published kind:3 to relays: ${publicItems.length} public follows`);

  // Publish kind:30000 event for private follows (if feature enabled)
  if (isPrivateFollowsEnabled() && privateItems.length > 0) {
    try {
      const { encryptPrivateFollows } = await import('../helpers/encryptPrivateFollows');
      const privatePubkeys = privateItems.map(item => item.pubkey);
      const encryptedContent = await encryptPrivateFollows(privatePubkeys, user.pubkey);

      const kind30000Event = {
        kind: 30000,
        created_at: now(),
        tags: [['d', 'private-follows']],
        content: encryptedContent,
        pubkey: user.pubkey
      };

      const signedKind30000 = await signEvent(kind30000Event);
      if (signedKind30000) {
        await publishEvent(signedKind30000);
        logger.info('follows.ts', `Published kind:30000 to relays: ${privateItems.length} private follows`);
      }
    } catch (error) {
      logger.error('follows.ts', `Failed to publish private follows: ${error}`);
      throw error;
    }
  }
}

// ============================================================
// SYNC HELPERS (used by FollowStorageAdapter and FollowListManager)
// ============================================================

function calculateFollowSyncDiff(browserItems: FollowItem[], relayItems: FollowItem[], preservePrivateItems: boolean = false): SyncDiff {
  const browserIds = new Set(browserItems.map(item => item.pubkey));
  const relayIds = new Set(relayItems.map(item => item.pubkey));

  const added = relayItems.filter(item => !browserIds.has(item.pubkey));
  const removed = browserItems.filter(item => {
    if (!relayIds.has(item.pubkey)) {
      if (preservePrivateItems && item.isPrivate === true) {
        return false;
      }
      return true;
    }
    return false;
  });
  const unchanged = browserItems.filter(item => relayIds.has(item.pubkey));

  return { added, removed, unchanged };
}

function mergeFollowItems(browserItems: FollowItem[], newItems: FollowItem[]): FollowItem[] {
  const map = new Map<string, FollowItem>();
  browserItems.forEach(item => map.set(item.pubkey, item));
  newItems.forEach(item => {
    if (!map.has(item.pubkey)) {
      map.set(item.pubkey, item);
    }
  });
  return Array.from(map.values());
}

// ============================================================
// FOLLOW STORAGE ADAPTER (self-contained, no external dependencies)
// ============================================================

/**
 * Storage adapter for sync operations
 * All methods are self-contained - no external base class
 */
export class FollowStorageAdapter {
  getItemId(item: FollowItem): string {
    return item.pubkey;
  }

  getBrowserItems(): FollowItem[] {
    return getFollowItems();
  }

  setBrowserItems(items: FollowItem[]): void {
    setFollowItems(items);
  }

  async getFileItems(): Promise<FollowItem[]> {
    return await getFileFollows();
  }

  async setFileItems(_items: FollowItem[]): Promise<void> {
    await saveToFile();
  }

  async fetchFromRelays(): Promise<FetchFromRelaysResult> {
    return await fetchFromRelays();
  }

  async publishToRelays(_items: FollowItem[]): Promise<void> {
    await publishToRelays();
  }

  // Sync helper methods (for AutoSyncService)
  async syncFromRelays(): Promise<SyncFromRelaysResult> {
    const fetchResult = await this.fetchFromRelays();
    const relayItems = fetchResult.items;
    const relayContentWasEmpty = fetchResult.relayContentWasEmpty;
    const decryptionFailed = fetchResult.decryptionFailed || false;
    const browserItems = this.getBrowserItems();

    const preservePrivateItems = relayContentWasEmpty || decryptionFailed;
    const diff = calculateFollowSyncDiff(browserItems, relayItems, preservePrivateItems);

    return {
      requiresConfirmation: diff.removed.length > 0,
      diff,
      relayItems,
      relayContentWasEmpty: preservePrivateItems
    };
  }

  applySyncFromRelays(strategy: 'merge' | 'overwrite', relayItems: FollowItem[], relayContentWasEmpty: boolean = false): void {
    const browserItems = this.getBrowserItems();

    if (strategy === 'overwrite') {
      if (relayContentWasEmpty) {
        const localPrivateItems = browserItems.filter(item => item.isPrivate === true);
        this.setBrowserItems([...relayItems, ...localPrivateItems]);
      } else {
        this.setBrowserItems(relayItems);
      }
    } else {
      this.setBrowserItems(mergeFollowItems(browserItems, relayItems));
    }
  }
}

// ============================================================
// FOLLOW ORCHESTRATOR (Legacy alias for backward compatibility)
// ============================================================

// Sync state tracking (Race Condition Prevention)
let isSyncing = false;
let lastSyncedFollowCount = 0;
let lastSyncTimestamp = 0;

/**
 * FollowListOrchestrator-compatible interface
 * This allows existing code to keep working while we migrate
 */
export const FollowOrchestrator = {
  getInstance: () => ({
    // Settings
    isPrivateFollowsEnabled,
    setPrivateFollowsEnabled,

    // Status
    isSyncInProgress: () => isSyncing,
    getLastSyncedFollowCount: () => lastSyncedFollowCount,
    getLastSyncTimestamp: () => lastSyncTimestamp,

    // Follow operations
    addFollow: async (pubkey: string, isPrivate: boolean) => followUser(pubkey, isPrivate),
    removeFollow: async (pubkey: string) => unfollowUser(pubkey),
    getAllFollowsWithStatus: async () => getAllFollowsWithStatus(),

    // Combined follow list
    getCombinedFollowList: async (_pubkey: string, isInitialSync: boolean = false) => {
      if (isInitialSync) {
        isSyncing = true;
        logger.info('FollowOrchestrator', 'Starting initial sync...');
        AppState.getInstance().setState('user', { syncStatus: { status: 'syncing' } });
      }

      try {
        // Check if migration needed
        if (!isMigratedToFileStorage()) {
          logger.info('FollowOrchestrator', 'First run - migrating from relay to file storage...');
          const relayResult = await fetchFromRelays();
          if (relayResult.items.length > 0) {
            setFollowItems(relayResult.items);
            await saveToFile();
          }
          setMigratedToFileStorage();
        }

        // Read from browser storage
        const allFollows = getFollowItems();

        if (isInitialSync) {
          isSyncing = false;
          lastSyncedFollowCount = allFollows.length;
          lastSyncTimestamp = Date.now();
          logger.info('FollowOrchestrator', `Initial sync completed: ${allFollows.length} follows`);
          AppState.getInstance().setState('user', {
            syncStatus: { status: 'synced', count: allFollows.length, timestamp: lastSyncTimestamp }
          });
        }

        return allFollows;
      } catch (error) {
        if (isInitialSync) {
          isSyncing = false;
          logger.error('FollowOrchestrator', `Initial sync failed: ${error}`);
          AppState.getInstance().setState('user', { syncStatus: { status: 'error', error: String(error) } });
        }
        return [];
      }
    },

    // Publish
    publishFollowList: async (publicFollows: FollowItem[], privateFollows: FollowItem[], skipValidation: boolean = false) => {
      const currentUser = AuthService.getInstance().getCurrentUser();
      if (!currentUser) throw new Error('User not authenticated');

      if (isSyncing) throw new Error('Still syncing follow list. Please wait.');

      // Validate dramatic changes
      if (!skipValidation && lastSyncedFollowCount > 0) {
        const newTotal = publicFollows.length + privateFollows.length;
        const percentageChange = ((newTotal - lastSyncedFollowCount) / lastSyncedFollowCount) * 100;
        const isDramaticDrop = percentageChange < -50 || (lastSyncedFollowCount > 10 && newTotal <= 5);

        if (isDramaticDrop) {
          throw new Error(`Suspicious follow count change: ${lastSyncedFollowCount} → ${newTotal}`);
        }
      }

      // Write to files first
      await writePublicFollowsFile({ items: publicFollows, lastModified: now() });
      await writePrivateFollowsFile({ items: privateFollows, lastModified: now() });

      // Update browser storage
      const allItems = [
        ...publicFollows.map(f => ({ ...f, isPrivate: false })),
        ...privateFollows.map(f => ({ ...f, isPrivate: true }))
      ];
      setFollowItems(allItems);

      // Publish to relays
      await publishToRelays();

      lastSyncedFollowCount = publicFollows.length + privateFollows.length;
      lastSyncTimestamp = Date.now();

      return true;
    },

    // Fetch from relays (for sync button)
    fetchFollowsFromRelays: async (_pubkey: string) => {
      return await fetchFromRelays();
    },

    // Browser storage access
    getBrowserItems: () => getFollowItems(),
    setBrowserItems: (items: FollowItem[]) => setFollowItems(items),

    // File operations
    saveToFile,
    restoreFromFile,

    // Migration methods (public ↔ private)
    migrateToPrivate: async (_pubkey: string) => {
      const items = getFollowItems();
      const updatedItems = items.map(item => ({ ...item, isPrivate: true }));
      setFollowItems(updatedItems);
      await saveToFile();
      await publishToRelays();
      return true;
    },

    migrateToPublic: async (_pubkey: string) => {
      const items = getFollowItems();
      const updatedItems = items.map(item => ({ ...item, isPrivate: false }));
      setFollowItems(updatedItems);
      await saveToFile();
      await publishToRelays();
      return true;
    }
  })
};

// Also export as FollowListOrchestrator for existing imports
export const FollowListOrchestrator = {
  getInstance: FollowOrchestrator.getInstance
};

// ============================================================
// PROFILE FOLLOW MANAGER (profile follow/unfollow UI)
// ============================================================

export interface FollowState {
  isFollowing: boolean;
  followingCount: number;
}

export class ProfileFollowManager {
  private authService: AuthService;
  private targetPubkey: string;
  private isFollowingState: boolean = false;

  constructor(targetPubkey: string) {
    this.targetPubkey = targetPubkey;
    this.authService = AuthService.getInstance();
  }

  /**
   * Check if current user follows the target profile
   */
  public async checkFollowStatus(): Promise<boolean> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser || this.targetPubkey === currentUser.pubkey) {
      return false;
    }

    // Read from browser storage
    let browserItems = getFollowItems();

    // If empty, try to restore from files
    if (browserItems.length === 0) {
      try {
        const fileItems = await getFileFollows();
        if (fileItems.length > 0) {
          setFollowItems(fileItems);
          browserItems = fileItems;
        }
      } catch {
        // File read failed, continue with empty
      }
    }

    this.isFollowingState = browserItems.some(item => item.pubkey === this.targetPubkey);
    return this.isFollowingState;
  }

  /**
   * Get current follow status
   */
  public getFollowStatus(): boolean {
    return this.isFollowingState;
  }

  /**
   * Render follow button HTML
   */
  public renderFollowButton(): string {
    const currentUser = this.authService.getCurrentUser();

    // No button for self or when logged out
    if (!currentUser || this.targetPubkey === currentUser.pubkey) {
      return '';
    }

    // Already following - show unfollow button
    if (this.isFollowingState) {
      return `
        <button class="btn btn--passive follow-btn" data-action="unfollow">
          Unfollow
        </button>
      `;
    }

    // Not following - show follow button (with dropdown if private follows enabled)
    if (!isPrivateFollowsEnabled()) {
      return `
        <button class="btn follow-btn" data-action="follow">
          Follow 🫂
        </button>
      `;
    }

    return `
      <div class="follow-dropdown-container">
        <button class="btn follow-btn-dropdown" id="follow-btn-dropdown">
          Follow 🫂
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-left: 4px;">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
        <div class="follow-dropdown-menu" id="follow-dropdown-menu">
          <button class="follow-dropdown-item" data-action="follow-public">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="2" y1="12" x2="22" y2="12"></line>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
            </svg>
            Follow publicly
          </button>
          <button class="follow-dropdown-item" data-action="follow-private">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            Follow privately
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Setup follow button event handlers
   */
  public setupFollowButton(container: HTMLElement, onStateChange: () => void): void {
    if (!container || !container.isConnected) return;

    // Handle unfollow button
    const unfollowBtn = container.querySelector('.follow-btn[data-action="unfollow"]');
    if (unfollowBtn) {
      unfollowBtn.addEventListener('click', async () => {
        await this.handleUnfollow(container, onStateChange);
      });
      return;
    }

    // Handle simple follow button (NIP-51 disabled)
    const simpleFollowBtn = container.querySelector('.follow-btn[data-action="follow"]');
    if (simpleFollowBtn) {
      simpleFollowBtn.addEventListener('click', async () => {
        await this.handleFollow(container, 'public', onStateChange);
      });
      return;
    }

    // Handle follow dropdown (NIP-51 enabled)
    const dropdownBtn = container.querySelector('#follow-btn-dropdown');
    const dropdownMenu = container.querySelector('#follow-dropdown-menu');

    if (!dropdownBtn || !dropdownMenu) return;

    dropdownBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdownMenu.classList.toggle('show');
    });

    document.addEventListener('click', () => {
      dropdownMenu.classList.remove('show');
    });

    const dropdownItems = container.querySelectorAll('.follow-dropdown-item');
    dropdownItems.forEach(item => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = (item as HTMLElement).dataset.action;
        dropdownMenu.classList.remove('show');

        if (action === 'follow-public') {
          await this.handleFollow(container, 'public', onStateChange);
        } else if (action === 'follow-private') {
          await this.handleFollow(container, 'private', onStateChange);
        }
      });
    });
  }

  /**
   * Handle follow action
   */
  private async handleFollow(container: HTMLElement, type: 'public' | 'private', onStateChange: () => void): Promise<void> {
    if (!container || !container.isConnected) return;

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return;

    if (isSyncing) {
      ToastService.show('Still syncing follow list. Please wait.', 'warning');
      return;
    }

    const dropdownBtn = container.querySelector('#follow-btn-dropdown') as HTMLButtonElement;
    const simpleBtn = container.querySelector('.follow-btn[data-action="follow"]') as HTMLButtonElement;
    const followBtn = dropdownBtn || simpleBtn;

    if (!followBtn) return;

    const originalHTML = followBtn.innerHTML;

    try {
      followBtn.disabled = true;
      followBtn.textContent = 'Following...';

      followUser(this.targetPubkey, type === 'private');

      this.isFollowingState = true;
      eventBus.emit('follow:updated', {});
      onStateChange();

      ToastService.show(`Followed ${type === 'public' ? 'publicly' : 'privately'} (local)`, 'success');
    } catch (error) {
      console.error('Failed to follow:', error);
      ToastService.show('Failed to follow user', 'error');

      followBtn.disabled = false;
      followBtn.innerHTML = originalHTML;
      this.setupFollowButton(container, onStateChange);
    }
  }

  /**
   * Handle unfollow action
   */
  private async handleUnfollow(container: HTMLElement, onStateChange: () => void): Promise<void> {
    if (!container || !container.isConnected) return;

    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return;

    if (isSyncing) {
      ToastService.show('Still syncing follow list. Please wait.', 'warning');
      return;
    }

    const followBtn = container.querySelector('.follow-btn') as HTMLButtonElement;
    if (!followBtn) return;

    try {
      followBtn.disabled = true;
      followBtn.textContent = 'Unfollowing...';

      unfollowUser(this.targetPubkey);

      this.isFollowingState = false;
      eventBus.emit('follow:updated', {});
      onStateChange();

      ToastService.show('Unfollowed successfully (local)', 'success');
    } catch (error) {
      console.error('Failed to unfollow:', error);
      ToastService.show('Failed to unfollow user', 'error');

      followBtn.disabled = false;
      followBtn.textContent = 'Unfollow';
    }
  }
}

// ============================================================
// FOLLOW LIST MANAGER (sidebar list UI)
// ============================================================

export class FollowListManager {
  // Base properties
  private eventBus: EventBus;
  private authService: AuthService;
  private containerElement: HTMLElement;
  private infiniteScroll: InfiniteScroll | null = null;
  private allItemsWithProfiles: FollowItemWithProfile[] = [];
  private currentOffset: number = 0;
  private hasMore: boolean = true;
  private isLoading: boolean = false;
  private readonly BATCH_SIZE: number = 20;

  // Follow-specific properties
  private followOrch: ReturnType<typeof FollowListOrchestrator.getInstance>;
  private userProfileService: UserProfileService;
  private mutualService: MutualService;
  private mutualChangeDetector: MutualChangeDetector;
  private mutualChangeStorage: MutualChangeStorage;
  private zapStatsService: ZapStatsService;
  private router: Router;
  private adapter: FollowStorageAdapter;

  // Stats and filter
  private totalFollowing: number = 0;
  private mutualCount: number = 0;
  private showOnlyNonMutuals: boolean = false;
  private zapStatsLoaded: boolean = false;

  // Sorting and loading state
  private isFullyLoaded: boolean = false;
  private currentSort: 'date' | 'zaps' = 'date';
  private isLoadingAll: boolean = false;
  private originalOrder: string[] = []; // Store original pubkey order for date sorting
  private usernameFilter: string = ''; // Filter by username

  constructor(containerElement: HTMLElement) {
    this.containerElement = containerElement;
    this.eventBus = EventBus.getInstance();
    this.authService = AuthService.getInstance();

    this.adapter = new FollowStorageAdapter();
    this.followOrch = FollowListOrchestrator.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.mutualService = MutualService.getInstance();
    this.mutualChangeDetector = MutualChangeDetector.getInstance();
    this.mutualChangeStorage = MutualChangeStorage.getInstance();
    this.zapStatsService = ZapStatsService.getInstance();
    this.router = Router.getInstance();

    this.setupEventListeners();
  }

  /**
   * Setup event listeners (inlined from BaseListManager)
   */
  private setupEventListeners(): void {
    this.eventBus.on('follow:updated', () => this.refreshListIfActive());
    this.eventBus.on('user:logout', () => {
      this.refreshListIfActive();
      this.switchToSystemLogsTab();
    });
    this.eventBus.on('user:login', () => {
      this.resetBatchState();
      this.refreshListIfActive();
      // Follow-specific resets
      this.totalFollowing = 0;
      this.mutualCount = 0;
      this.zapStatsLoaded = false;
      this.isFullyLoaded = false;
      this.originalOrder = [];
      this.usernameFilter = '';
    });
    this.eventBus.on('list-sync-mode:changed', () => this.refreshListIfActive());

    // Listen for zap stats loaded event
    this.eventBus.on('zapstats:loaded', () => {
      this.zapStatsLoaded = true;
      this.updateAllZapBadges();
      const container = this.containerElement.querySelector('[data-tab-content="list-follows"]') as HTMLElement;
      if (container) {
        this.updateSortControlsUI(container);
      }
    });

    // Listen for mutual changes detected (update green dot)
    this.eventBus.on('mutual-changes:detected', () => {
      this.updateGreenDot();
    });

    // Listen for mutual changes seen (remove green dot)
    this.eventBus.on('mutual-changes:seen', () => {
      this.updateGreenDot();
    });
  }

  /**
   * Reset batch loading state (inlined from BaseListManager)
   */
  private resetBatchState(): void {
    this.allItemsWithProfiles = [];
    this.currentOffset = 0;
    this.hasMore = true;
    this.isLoading = false;
  }

  /**
   * Refresh list if it's currently active (inlined from BaseListManager)
   */
  private refreshListIfActive(): void {
    const listTab = this.containerElement.querySelector('[data-tab-content="list-follows"]');
    if (listTab?.classList.contains('tab-content--active')) {
      this.renderListTab(listTab as HTMLElement).catch(err => {
        console.error('Failed to refresh Follows:', err);
      });
    }
  }

  /**
   * Switch to System Logs tab (inlined from BaseListManager)
   */
  private switchToSystemLogsTab(): void {
    switchTabWithContent(this.containerElement, 'system-log');
  }

  /**
   * Handle load more (infinite scroll trigger) (inlined from BaseListManager)
   */
  private async handleLoadMore(): Promise<void> {
    const list = this.containerElement.querySelector('.follows-list');
    if (!list || this.isLoading || !this.hasMore) return;
    await this.loadBatch(list as HTMLElement);
  }

  /**
   * Render control buttons based on sync mode (inlined from BaseListManager)
   */
  private renderControlButtons(): string {
    return renderListSyncButtons();
  }

  /**
   * Bind sync button handlers (inlined from BaseListManager)
   */
  private bindSyncButtons(container: HTMLElement): void {
    const bindButton = (className: string, handler: () => Promise<void>): void => {
      container.querySelectorAll(`.${className}`).forEach(btn => {
        btn.addEventListener('click', handler);
      });
    };

    bindButton('sync-from-relays-btn', () => this.handleSyncFromRelays(container));
    bindButton('sync-to-relays-btn', () => this.handleSyncToRelays());
    bindButton('save-to-file-btn', () => this.handleSaveToFile());
    bindButton('restore-from-file-btn', () => this.handleRestoreFromFile(container));
    bindSwitchSyncModeLink(container, () => this.renderListTab(container));
  }

  // ===== Sync Helper Methods (inlined from ListSyncManager) =====

  /**
   * Calculate diff between browser and relay/file items
   */
  private calculateDiff(browserItems: FollowItem[], relayItems: FollowItem[], preservePrivateItems: boolean = false): SyncDiff {
    const browserIds = new Set(browserItems.map(item => item.pubkey));
    const relayIds = new Set(relayItems.map(item => item.pubkey));

    const added = relayItems.filter(item => !browserIds.has(item.pubkey));
    const removed = browserItems.filter(item => {
      if (!relayIds.has(item.pubkey)) {
        if (preservePrivateItems && item.isPrivate === true) {
          return false;
        }
        return true;
      }
      return false;
    });
    const unchanged = browserItems.filter(item => relayIds.has(item.pubkey));

    return { added, removed, unchanged };
  }

  /**
   * Merge browser items with relay/file items (union)
   */
  private mergeFollowItems(browserItems: FollowItem[], newItems: FollowItem[]): FollowItem[] {
    const map = new Map<string, FollowItem>();
    browserItems.forEach(item => map.set(item.pubkey, item));
    newItems.forEach(item => {
      if (!map.has(item.pubkey)) {
        map.set(item.pubkey, item);
      }
    });
    return Array.from(map.values());
  }

  /**
   * Sync from relays - Phase 1: Fetch and compare
   */
  private async syncFromRelays(): Promise<SyncFromRelaysResult> {
    const fetchResult = await this.adapter.fetchFromRelays();
    const relayItems = fetchResult.items;
    const relayContentWasEmpty = fetchResult.relayContentWasEmpty;
    const decryptionFailed = fetchResult.decryptionFailed || false;
    const browserItems = this.adapter.getBrowserItems();

    const preservePrivateItems = relayContentWasEmpty || decryptionFailed;
    const diff = this.calculateDiff(browserItems, relayItems, preservePrivateItems);
    const requiresConfirmation = diff.removed.length > 0;

    return {
      requiresConfirmation,
      diff,
      relayItems,
      relayContentWasEmpty: preservePrivateItems
    };
  }

  /**
   * Sync from relays - Phase 2: Apply
   */
  private applySyncFromRelays(strategy: 'merge' | 'overwrite', relayItems: FollowItem[], relayContentWasEmpty: boolean = false): void {
    const browserItems = this.adapter.getBrowserItems();

    if (strategy === 'overwrite') {
      if (relayContentWasEmpty) {
        const localPrivateItems = browserItems.filter(item => item.isPrivate === true);
        this.adapter.setBrowserItems([...relayItems, ...localPrivateItems]);
      } else {
        this.adapter.setBrowserItems(relayItems);
      }
    } else {
      const merged = this.mergeFollowItems(browserItems, relayItems);
      this.adapter.setBrowserItems(merged);
    }
  }

  /**
   * Sync from file - Phase 1: Read and compare
   */
  private async syncFromFile(): Promise<SyncFromFileResult> {
    const fileItems = await this.adapter.getFileItems();
    const browserItems = this.adapter.getBrowserItems();
    const diff = this.calculateDiff(browserItems, fileItems, false);
    const requiresConfirmation = diff.removed.length > 0;

    return { requiresConfirmation, diff, fileItems };
  }

  /**
   * Sync from file - Phase 2: Apply
   */
  private applySyncFromFile(strategy: 'merge' | 'overwrite', fileItems: FollowItem[]): void {
    const browserItems = this.adapter.getBrowserItems();

    if (strategy === 'overwrite') {
      this.adapter.setBrowserItems(fileItems);
    } else {
      const merged = this.mergeFollowItems(browserItems, fileItems);
      this.adapter.setBrowserItems(merged);
    }
  }

  // ===== Sync Button Handlers =====

  /**
   * Handle Sync from Relays
   */
  private async handleSyncFromRelays(container: HTMLElement): Promise<void> {
    try {
      ToastService.show('Fetching from relays...', 'info');
      const result = await this.syncFromRelays();

      if (result.requiresConfirmation) {
        const modal = new SyncConfirmationModal({
          listType: 'Follows',
          added: result.diff.added,
          removed: result.diff.removed,
          getDisplayName: async (item: FollowItem) => {
            const profile = await this.userProfileService.getUserProfile(item.pubkey);
            return extractDisplayName(profile);
          },
          onKeep: async () => {
            this.applySyncFromRelays('merge', result.relayItems, result.relayContentWasEmpty);
            ToastService.show(`Merged ${result.diff.added.length} new follows (kept ${result.diff.removed.length} local follows)`, 'success');
            await this.renderListTab(container);
          },
          onDelete: async () => {
            this.applySyncFromRelays('overwrite', result.relayItems, result.relayContentWasEmpty);
            ToastService.show(`Synced from relays (added ${result.diff.added.length}, removed ${result.diff.removed.length})`, 'success');
            await this.renderListTab(container);
          }
        });
        await modal.show();
      } else {
        this.applySyncFromRelays('merge', result.relayItems, result.relayContentWasEmpty);
        ToastService.show(`Synced ${result.diff.added.length} new follow${result.diff.added.length !== 1 ? 's' : ''} from relays`, 'success');
        await this.renderListTab(container);
      }
    } catch (error) {
      console.error('Failed to sync from relays:', error);
      ToastService.show('Failed to sync from relays', 'error');
    }
  }

  /**
   * Handle Sync to Relays
   */
  private async handleSyncToRelays(): Promise<void> {
    try {
      ToastService.show('Publishing to relays...', 'info');
      const browserItems = this.adapter.getBrowserItems();
      await this.adapter.publishToRelays(browserItems);
      ToastService.show('Follows published successfully', 'success');
    } catch (error) {
      console.error('Failed to publish to relays:', error);
      ToastService.show('Failed to publish to relays', 'error');
    }
  }

  /**
   * Handle Save to File
   */
  private async handleSaveToFile(): Promise<void> {
    try {
      ToastService.show('Saving...', 'info');
      const browserItems = this.adapter.getBrowserItems();

      if (PlatformService.getInstance().isTauri) {
        await this.adapter.setFileItems(browserItems);
      } else {
        this.downloadAsJson(browserItems, 'follows');
      }
      ToastService.show('Saved successfully', 'success');
    } catch (error) {
      console.error('Failed to save to file:', error);
      ToastService.show('Failed to save', 'error');
    }
  }

  /**
   * Download data as JSON file (Browser fallback)
   */
  private downloadAsJson(data: FollowItem[], filename: string): void {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `noornote-${filename.toLowerCase()}-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Handle Restore from File
   * In Browser/Mobile: shows file upload dialog
   * In Tauri Desktop: reads from local file
   */
  private async handleRestoreFromFile(container: HTMLElement): Promise<void> {
    try {
      let result: SyncFromFileResult;

      if (PlatformService.getInstance().isBrowser) {
        // Browser/Mobile: Upload file via dialog
        const uploadedItems = await uploadJsonFile<FollowItem[]>();
        if (!uploadedItems) {
          return; // User cancelled
        }
        const browserItems = this.adapter.getBrowserItems();
        const diff = this.calculateDiff(browserItems, uploadedItems, false);
        result = { requiresConfirmation: diff.removed.length > 0, diff, fileItems: uploadedItems };
      } else {
        // Tauri Desktop: Read from local file
        ToastService.show('Reading from file...', 'info');
        result = await this.syncFromFile();
      }

      if (result.requiresConfirmation) {
        const modal = new SyncConfirmationModal({
          listType: 'Follows (File)',
          added: result.diff.added,
          removed: result.diff.removed,
          getDisplayName: async (item: FollowItem) => {
            const profile = await this.userProfileService.getUserProfile(item.pubkey);
            return extractDisplayName(profile);
          },
          onKeep: async () => {
            this.applySyncFromFile('merge', result.fileItems);
            ToastService.show(`Merged ${result.diff.added.length} from file (kept ${result.diff.removed.length} local)`, 'success');
            await this.renderListTab(container);
          },
          onDelete: async () => {
            this.applySyncFromFile('overwrite', result.fileItems);
            ToastService.show(`Restored from file (added ${result.diff.added.length}, removed ${result.diff.removed.length})`, 'success');
            await this.renderListTab(container);
          }
        });
        modal.show();
      } else if (result.diff.added.length > 0) {
        this.applySyncFromFile('overwrite', result.fileItems);
        ToastService.show(`Restored ${result.diff.added.length} item${result.diff.added.length > 1 ? 's' : ''} from file`, 'success');
        await this.renderListTab(container);
      } else {
        ToastService.show('File is identical to current list', 'info');
      }
    } catch (error) {
      console.error('Failed to restore from file:', error);
      ToastService.show(`Failed to restore: ${error}`, 'error');
    }
  }

  /**
   * Escape HTML (inlined from BaseListManager)
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Cleanup (inlined from BaseListManager)
   */
  public destroy(): void {
    if (this.infiniteScroll) {
      this.infiniteScroll.destroy();
      this.infiniteScroll = null;
    }
  }

  /**
   * Initialize browser storage (placeholder for consistency)
   */
  private async initializeBrowserStorage(): Promise<void> {
    // No automatic restore - app uses last browser state
  }

  /**
   * Fetch all follows with profiles and mutual status
   */
  private async getAllItemsWithProfiles(): Promise<FollowItemWithProfile[]> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    // Cascading restore: browser → file → relays (if browser empty)
    let allFollows = this.adapter.getBrowserItems();

    if (allFollows.length === 0) {
      // Try file first
      try {
        const fileItems = await this.adapter.getFileItems();
        if (fileItems.length > 0) {
          this.adapter.setBrowserItems(fileItems);
          allFollows = fileItems;
        }
      } catch {
        // File read failed, continue
      }

      // If still empty, try relays
      if (allFollows.length === 0) {
        try {
          const relayResult = await this.adapter.fetchFromRelays();
          if (relayResult.items.length > 0) {
            this.adapter.setBrowserItems(relayResult.items);
            allFollows = relayResult.items;
          }
        } catch {
          // Relay fetch failed, continue with empty
        }
      }
    }

    // Get public/private status from files (fallback for items without browser flag)
    const followStatus = await this.followOrch.getAllFollowsWithStatus();

    // Fetch profiles for all followed users
    const followsWithProfiles: FollowItemWithProfile[] = await Promise.all(
      allFollows.map(async (item) => {
        // Priority: browser item's isPrivate flag, then file status
        const fileStatus = followStatus.get(item.pubkey);
        const isPrivate = item.isPrivate !== undefined
          ? item.isPrivate
          : (fileStatus?.private === true);

        return {
          ...item,
          profile: await this.userProfileService.getUserProfile(item.pubkey),
          isPrivate,
          isMutual: false // Will be updated per batch
        };
      })
    );

    // Reverse to show newest first (tag order in Kind 3 = chronological, oldest first)
    followsWithProfiles.reverse();

    // Store total count
    this.totalFollowing = followsWithProfiles.length;

    return followsWithProfiles;
  }

  /**
   * Render list tab content with sticky header, stats and filter
   */
  private async renderListTab(container: HTMLElement): Promise<void> {
    // Initialize browser storage from file on first render
    await this.initializeBrowserStorage();

    // Clean up existing infinite scroll
    if (this.infiniteScroll) {
      this.infiniteScroll.destroy();
      this.infiniteScroll = null;
    }

    // Reset state
    this.allItemsWithProfiles = [];
    this.currentOffset = 0;
    this.hasMore = true;
    this.isLoading = false;
    this.mutualCount = 0;
    this.zapStatsLoaded = false;
    this.isFullyLoaded = false;
    this.currentSort = 'date';
    this.isLoadingAll = false;

    // Clear unseen changes when tab is opened
    if (this.mutualChangeStorage.hasUnseenChanges()) {
      this.mutualChangeStorage.setUnseenChanges(false);
      this.updateGreenDot();
    }

    try {
      const currentUser = this.authService.getCurrentUser();

      if (!currentUser) {
        container.innerHTML = `
          <div class="follows-list-empty-state">
            <p>Log in to see your follows</p>
          </div>
        `;
        return;
      }

      // Show loading state
      container.innerHTML = `
        <div class="follows-list-loading">
          Loading follows...
        </div>
      `;

      // Fetch all items with profiles
      const itemsWithProfiles = await this.getAllItemsWithProfiles();

      if (itemsWithProfiles.length === 0) {
        container.innerHTML = this.renderControlButtons() + `
          <div class="follows-list-empty-state">
            <p>No follows yet</p>
          </div>
        ` + this.renderControlButtons();
        this.bindSyncButtons(container);
        return;
      }

      // Store all items for batch loading
      this.allItemsWithProfiles = itemsWithProfiles;

      // Store original order for date sorting
      this.originalOrder = itemsWithProfiles.map(item => item.pubkey);

      // Get last check info for display
      const lastCheckTimestamp = this.mutualChangeStorage.getLastCheckTimestamp();
      const lastCheckText = lastCheckTimestamp ? this.formatTimeAgo(lastCheckTimestamp) : 'Never';

      // Render container with sticky header, controls and list
      container.innerHTML = `
        ${this.renderControlButtons()}
        <div class="follows-header">
          <div class="follows-stats">
            Following: ${this.totalFollowing} | Mutuals: <span class="mutual-count">...</span> (<span class="mutual-percentage">...</span>%)
          </div>
          <div class="follows-check-changes">
            <a href="#" class="follows-check-changes__link">Check for changes</a>
            <span class="follows-check-changes__last-check">Last: ${lastCheckText}</span>
          </div>
        </div>
        <div class="follows-sort-controls">
          <a href="#" class="follows-sort-controls__load-all">Load all</a>
          <span class="follows-sort-controls__sort">
            Sort by:
            <a href="#" class="follows-sort-controls__sort-date follows-sort-controls__link--disabled ${this.currentSort === 'date' ? 'active' : ''}">Date</a>
            /
            <a href="#" class="follows-sort-controls__sort-zaps follows-sort-controls__link--disabled ${this.currentSort !== 'date' ? 'active' : ''}">Zaps</a>
          </span>
          <input type="text"
                 class="follows-sort-controls__search ${this.isFullyLoaded ? '' : 'follows-sort-controls__search--disabled'}"
                 placeholder="Filter by name..."
                 ${this.isFullyLoaded ? '' : 'disabled'} />
          <label class="follows-sort-controls__non-mutuals ${this.isFullyLoaded ? '' : 'follows-sort-controls__non-mutuals--disabled'}">
            <input type="checkbox" class="follows-filter__toggle" ${this.showOnlyNonMutuals ? 'checked' : ''} ${this.isFullyLoaded ? '' : 'disabled'}>
            Non-mutuals only
          </label>
        </div>
        <div class="follows-list"></div>
        ${this.renderControlButtons()}
        <div class="mutual-changes-modal" style="display: none;"></div>
      `;

      // Bind sync button handlers
      this.bindSyncButtons(container);

      // Bind filter toggle
      const filterToggle = container.querySelector('.follows-filter__toggle') as HTMLInputElement;
      filterToggle?.addEventListener('change', () => {
        this.showOnlyNonMutuals = filterToggle.checked;
        this.reRenderList(container);
      });

      // Bind sort controls
      this.bindSortControls(container);

      // Bind check for changes link
      this.bindCheckForChanges(container);

      const list = container.querySelector('.follows-list');
      if (!list) return;

      // Load first batch
      await this.loadBatch(list as HTMLElement);

      // Update stats
      this.updateStats(container);

      // Setup infinite scroll if there are more items
      if (this.hasMore) {
        this.infiniteScroll = new InfiniteScroll(() => this.handleLoadMore(), {
          loadingMessage: 'Loading more follows...'
        });
        this.infiniteScroll.observe(list as HTMLElement);
      }

      // Start loading zap stats asynchronously (don't await)
      const allPubkeys = this.allItemsWithProfiles.map(item => item.pubkey);
      this.zapStatsService.loadStatsForPubkeys(allPubkeys);
    } catch (error) {
      console.error('Failed to render follows:', error);
      container.innerHTML = `
        <div class="follows-list-empty-state">
          <p>Failed to load follows</p>
        </div>
      `;
    }
  }

  /**
   * Bind "Check for Changes" link handler
   */
  private bindCheckForChanges(container: HTMLElement): void {
    const checkLink = container.querySelector('.follows-check-changes__link');
    checkLink?.addEventListener('click', async (e) => {
      e.preventDefault();
      await this.handleCheckForChanges(container);
    });
  }

  /**
   * Handle "Check for Changes" click
   */
  private async handleCheckForChanges(container: HTMLElement): Promise<void> {
    const checkLink = container.querySelector('.follows-check-changes__link');
    const lastCheckSpan = container.querySelector('.follows-check-changes__last-check');

    if (checkLink) {
      checkLink.textContent = 'Checking...';
      (checkLink as HTMLElement).style.pointerEvents = 'none';
    }

    try {
      const result = await this.mutualChangeDetector.detect();

      // Update last check text
      if (lastCheckSpan) {
        lastCheckSpan.textContent = 'Last: Just now';
      }

      if (result.isFirstCheck) {
        ToastService.show('Initial snapshot saved. Changes will be detected on next check.', 'info');
      } else if (result.totalChanges === 0) {
        ToastService.show('No changes detected', 'success');
      } else {
        // Show modal with results
        this.showChangesModal(container, result);
      }
    } catch (error) {
      console.error('Failed to check for changes:', error);
      ToastService.show('Failed to check for changes', 'error');
    } finally {
      if (checkLink) {
        checkLink.textContent = 'Check for changes';
        (checkLink as HTMLElement).style.pointerEvents = '';
      }
    }
  }

  /**
   * Show modal with detected changes
   */
  private async showChangesModal(
    container: HTMLElement,
    result: { unfollows: string[]; newMutuals: string[]; totalChanges: number }
  ): Promise<void> {
    const modal = container.querySelector('.mutual-changes-modal') as HTMLElement;
    if (!modal) return;

    // Fetch profiles for display (keep pubkey + profile together)
    const unfollowData = await Promise.all(
      result.unfollows.map(async (pubkey) => {
        const profile = await this.userProfileService.getUserProfile(pubkey);
        return {
          pubkey,
          username: extractDisplayName(profile),
          avatarUrl: profile?.picture || ''
        };
      })
    );

    const newMutualData = await Promise.all(
      result.newMutuals.map(async (pubkey) => {
        const profile = await this.userProfileService.getUserProfile(pubkey);
        return {
          pubkey,
          username: extractDisplayName(profile),
          avatarUrl: profile?.picture || ''
        };
      })
    );

    modal.innerHTML = `
      <div class="mutual-changes-modal__backdrop"></div>
      <div class="mutual-changes-modal__content">
        <h3>Mutual Changes Detected</h3>
        <p class="mutual-changes-modal__summary">
          ${result.totalChanges} ${result.totalChanges === 1 ? 'change' : 'changes'} detected
        </p>

        ${newMutualData.length > 0 ? `
          <div class="mutual-changes-modal__section mutual-changes-modal__section--positive">
            <h4>New Mutuals (${newMutualData.length})</h4>
            <ul class="mutual-changes-modal__list">
              ${newMutualData.map(data => `
                <li class="mutual-changes-modal__item mutual-changes-modal__item--positive">
                  ${renderUserMention(data.pubkey, { username: data.username, avatarUrl: data.avatarUrl })} started following you back!
                </li>
              `).join('')}
            </ul>
          </div>
        ` : ''}

        ${unfollowData.length > 0 ? `
          <div class="mutual-changes-modal__section mutual-changes-modal__section--negative">
            <h4>Unfollows (${unfollowData.length})</h4>
            <ul class="mutual-changes-modal__list">
              ${unfollowData.map(data => `
                <li class="mutual-changes-modal__item mutual-changes-modal__item--negative">
                  ${renderUserMention(data.pubkey, { username: data.username, avatarUrl: data.avatarUrl })} stopped following back
                </li>
              `).join('')}
            </ul>
          </div>
        ` : ''}

        <div class="mutual-changes-modal__actions">
          <button class="btn btn--primary mutual-changes-modal__mark-seen">Mark as Seen</button>
          <button class="btn btn--passive mutual-changes-modal__close">Close</button>
        </div>
      </div>
    `;

    modal.style.display = 'flex';

    setupUserMentionHandlers(modal);

    const closeModal = (): void => {
      modal.style.display = 'none';
    };

    modal.querySelector('.mutual-changes-modal__mark-seen')?.addEventListener('click', async () => {
      await this.mutualChangeDetector.markAsSeen();
      closeModal();
      ToastService.show('Changes marked as seen', 'success');
    });

    modal.querySelector('.mutual-changes-modal__close')?.addEventListener('click', closeModal);
    modal.querySelector('.mutual-changes-modal__backdrop')?.addEventListener('click', closeModal);
  }

  /**
   * Update green dot indicator in sidebar
   */
  private updateGreenDot(): void {
    const hasUnseen = this.mutualChangeStorage.hasUnseenChanges();

    // Find the follows tab button in sidebar and update dot
    const tabButton = document.querySelector('[data-tab="list-follows"]');
    if (tabButton) {
      const existingDot = tabButton.querySelector('.follows-unseen-dot');
      if (hasUnseen && !existingDot) {
        const dot = document.createElement('span');
        dot.className = 'follows-unseen-dot';
        tabButton.appendChild(dot);
      } else if (!hasUnseen && existingDot) {
        existingDot.remove();
      }
    }
  }

  /**
   * Format timestamp as relative time
   */
  private formatTimeAgo(timestamp: number): string {
    const diffMs = Date.now() - timestamp;
    const minutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
  }

  /**
   * Load batch with mutual status check
   */
  private async loadBatch(listElement: HTMLElement): Promise<void> {
    if (this.isLoading || !this.hasMore) return;

    this.isLoading = true;

    if (this.currentOffset > 0 && this.infiniteScroll) {
      this.infiniteScroll.showLoading();
    }

    try {
      // Get next batch
      const batch = this.allItemsWithProfiles.slice(
        this.currentOffset,
        this.currentOffset + this.BATCH_SIZE
      );

      if (batch.length === 0) {
        this.hasMore = false;
        if (this.infiniteScroll) {
          this.infiniteScroll.hideLoading();
        }
        return;
      }

      // Check mutual status for this batch
      const batchWithMutualStatus = await this.mutualService.checkMutualStatusBatch(
        batch.map(item => ({ id: item.pubkey, pubkey: item.pubkey }))
      );

      // Update items with mutual status
      batch.forEach((item, idx) => {
        item.isMutual = batchWithMutualStatus[idx]?.isMutual ?? false;
        if (item.isMutual) {
          this.mutualCount++;
        }
      });

      // Render batch
      this.renderBatch(listElement, batch);

      // Update offset
      this.currentOffset += batch.length;

      // Check if there are more items
      if (this.currentOffset >= this.allItemsWithProfiles.length) {
        this.hasMore = false;
      }

      // Update stats
      const container = listElement.closest('[data-tab-content]') as HTMLElement;
      if (container) {
        this.updateStats(container);
      }
    } catch (error) {
      console.error('Failed to load batch:', error);
    } finally {
      this.isLoading = false;
      if (this.infiniteScroll) {
        this.infiniteScroll.hideLoading();
      }
    }
  }

  /**
   * Render batch of follow items with mutual badge and zap stats
   */
  private renderBatch(listElement: HTMLElement, batch: FollowItemWithProfile[]): void {
    const sentinel = listElement.querySelector('.infinite-scroll-sentinel');

    for (const item of batch) {
      if (this.showOnlyNonMutuals && item.isMutual) {
        continue;
      }

      const followItemDiv = this.createFollowItemElement(item);

      if (sentinel) {
        listElement.insertBefore(followItemDiv, sentinel);
      } else {
        listElement.appendChild(followItemDiv);
      }
    }
  }

  /**
   * Create a follow item DOM element with event handlers
   */
  private createFollowItemElement(item: FollowItemWithProfile): HTMLElement {
    const username = extractDisplayName(item.profile);
    const npub = hexToNpub(item.pubkey);
    const avatarUrl = item.profile?.picture || '';

    const mutualBadgeClass = item.isMutual ? 'mutual-badge--yes' : 'mutual-badge--no';
    const mutualBadgeText = item.isMutual ? 'Mutual' : 'Not following back';
    const zapBadgeHtml = this.renderZapBadge(item.pubkey);

    const followItemDiv = document.createElement('div');
    followItemDiv.className = 'ui-list__item follow-item';
    followItemDiv.dataset.pubkey = item.pubkey;
    followItemDiv.innerHTML = `
      <div class="follow-item__content-wrapper">
        <div class="follow-item__avatar">
          <img class="profile-pic profile-pic--medium" src="${avatarUrl}" alt="${username}" />
        </div>
        <div class="follow-item__info">
          <div class="follow-item__username">
            ${this.escapeHtml(username)}
            ${item.isPrivate ? '<span class="private-badge">🔒 Private</span>' : ''}
            ${this.renderArticleNotifLabel(item.pubkey)}
          </div>
          <div class="follow-item__badges">
            <span class="mutual-badge ${mutualBadgeClass}">${mutualBadgeText}</span>
            ${zapBadgeHtml}
          </div>
          ${item.petname ? `<div class="follow-item__petname">${this.escapeHtml(item.petname)}</div>` : ''}
        </div>
      </div>
      <button class="follow-item__unfollow-btn btn btn--passive btn--medium" data-pubkey="${item.pubkey}">
        Unfollow
      </button>
    `;

    const contentWrapper = followItemDiv.querySelector('.follow-item__content-wrapper');
    contentWrapper?.addEventListener('click', () => {
      this.router.navigate(`/profile/${npub}`);
    });

    const unfollowBtn = followItemDiv.querySelector('.follow-item__unfollow-btn');
    unfollowBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.handleRemoveItem(item, followItemDiv);
    });

    return followItemDiv;
  }

  /**
   * Render zap badge HTML
   */
  private renderZapBadge(pubkey: string): string {
    if (!this.zapStatsLoaded) {
      // Loading state with pulsing animation
      return `<span class="zap-stats-badge zap-stats-badge--loading" data-pubkey="${pubkey}">Zaps: Loading...</span>`;
    }

    const stats = this.zapStatsService.getStats(pubkey);
    if (!stats) {
      return `<span class="zap-stats-badge" data-pubkey="${pubkey}">Zaps: In (0) 0 | Out (0) 0</span>`;
    }

    const inSats = this.zapStatsService.formatSats(stats.incomingSats);
    const outSats = this.zapStatsService.formatSats(stats.outgoingSats);

    return `<span class="zap-stats-badge" data-pubkey="${pubkey}">Zaps: In (${stats.incomingCount}) ${inSats} | Out (${stats.outgoingCount}) ${outSats}</span>`;
  }

  /**
   * Update all zap badges after stats are loaded
   */
  private updateAllZapBadges(): void {
    const badges = this.containerElement.querySelectorAll('.zap-stats-badge');
    badges.forEach(badge => {
      const pubkey = badge.getAttribute('data-pubkey');
      if (!pubkey) return;

      const stats = this.zapStatsService.getStats(pubkey);
      badge.classList.remove('zap-stats-badge--loading');

      if (!stats) {
        badge.textContent = 'Zaps: In (0) 0 | Out (0) 0';
        return;
      }

      const inSats = this.zapStatsService.formatSats(stats.incomingSats);
      const outSats = this.zapStatsService.formatSats(stats.outgoingSats);
      badge.textContent = `Zaps: In (${stats.incomingCount}) ${inSats} | Out (${stats.outgoingCount}) ${outSats}`;
    });
  }

  /**
   * Re-render list (for filter toggle and sorting)
   */
  private reRenderList(container: HTMLElement): void {
    const list = container.querySelector('.follows-list');
    if (!list) return;

    const sentinel = list.querySelector('.infinite-scroll-sentinel');
    list.innerHTML = '';
    if (sentinel) {
      list.appendChild(sentinel);
    }

    for (const item of this.allItemsWithProfiles.slice(0, this.currentOffset)) {
      if (this.showOnlyNonMutuals && item.isMutual) {
        continue;
      }

      if (this.usernameFilter) {
        const username = extractDisplayName(item.profile).toLowerCase();
        if (!username.includes(this.usernameFilter)) {
          continue;
        }
      }

      const followItemDiv = this.createFollowItemElement(item);

      if (sentinel) {
        list.insertBefore(followItemDiv, sentinel);
      } else {
        list.appendChild(followItemDiv);
      }
    }
  }

  /**
   * Update stats display (mutual count and percentage only)
   */
  private updateStats(container: HTMLElement): void {
    const percentage = this.calculateMutualPercentage();

    const countEl = container.querySelector('.mutual-count');
    const percentEl = container.querySelector('.mutual-percentage');

    if (countEl) countEl.textContent = String(this.mutualCount);
    if (percentEl) percentEl.textContent = String(percentage);
  }

  /**
   * Update full stats header including total following count
   */
  private updateStatsHeader(container: HTMLElement): void {
    const percentage = this.calculateMutualPercentage();
    const statsEl = container.querySelector('.follows-stats');

    if (statsEl) {
      statsEl.innerHTML = `Following: ${this.totalFollowing} | Mutuals: <span class="mutual-count">${this.mutualCount}</span> (<span class="mutual-percentage">${percentage}</span>%)`;
    }
  }

  /**
   * Calculate mutual percentage
   */
  private calculateMutualPercentage(): number {
    if (this.totalFollowing === 0) return 0;
    return Math.round((this.mutualCount / this.totalFollowing) * 100);
  }

  /**
   * Handle unfollow (remove item)
   * Updates browser storage (localStorage) - use "Save to file" / "Sync to Relays" to persist
   */
  private async handleRemoveItem(item: FollowItemWithProfile, itemElement: HTMLElement): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return;

    try {
      const currentItems = this.adapter.getBrowserItems();
      const updatedItems = currentItems.filter((f: FollowItem) => f.pubkey !== item.pubkey);
      this.adapter.setBrowserItems(updatedItems);

      ToastService.show('Unfollowed user', 'success');

      itemElement.remove();

      if (item.isMutual) {
        this.mutualCount--;
      }
      this.totalFollowing--;
      this.allItemsWithProfiles = this.allItemsWithProfiles.filter(f => f.pubkey !== item.pubkey);

      const container = this.containerElement.querySelector('[data-tab-content="list-follows"]') as HTMLElement;
      if (container) {
        this.updateStatsHeader(container);
      }

      this.eventBus.emit('follow:updated', {});
    } catch (error) {
      console.error('Failed to unfollow user:', error);
      ToastService.show('Failed to unfollow user', 'error');
    }
  }

  /**
   * Handle tab switch (called by MainLayout)
   */
  public handleTabSwitch(tabName: string, content: HTMLElement): void {
    if (tabName === 'follows') {
      this.renderListTab(content).catch(err => {
        console.error('Failed to render follows tab:', err);
      });
    }
  }

  /**
   * Bind sort control event handlers
   */
  private bindSortControls(container: HTMLElement): void {
    // Load all link
    const loadAllLink = container.querySelector('.follows-sort-controls__load-all');
    loadAllLink?.addEventListener('click', (e) => {
      e.preventDefault();
      this.handleLoadAll(container);
    });

    // Sort by Date link
    const sortDateLink = container.querySelector('.follows-sort-controls__sort-date');
    sortDateLink?.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.isFullyLoaded && this.currentSort !== 'date') {
        this.currentSort = 'date';
        this.sortByDate();
        this.updateSortControlsUI(container);
        this.reRenderList(container);
      }
    });

    // Sort by Zaps link (requires both fully loaded AND zap stats loaded)
    const sortZapsLink = container.querySelector('.follows-sort-controls__sort-zaps');
    sortZapsLink?.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.isFullyLoaded && this.zapStatsLoaded && this.currentSort !== 'zaps') {
        this.currentSort = 'zaps';
        this.sortByZaps();
        this.updateSortControlsUI(container);
        this.reRenderList(container);
      }
    });

    // Username filter input
    const searchInput = container.querySelector('.follows-sort-controls__search') as HTMLInputElement;
    searchInput?.addEventListener('input', () => {
      this.usernameFilter = searchInput.value.toLowerCase();
      this.reRenderList(container);
    });
  }

  /**
   * Load all items in background
   */
  private async handleLoadAll(container: HTMLElement): Promise<void> {
    if (this.isLoadingAll || this.isFullyLoaded) return;

    this.isLoadingAll = true;

    // Update link text to show loading
    const loadAllLink = container.querySelector('.follows-sort-controls__load-all');
    if (loadAllLink) {
      loadAllLink.textContent = 'Loading...';
      loadAllLink.classList.add('follows-sort-controls__load-all--loading');
    }

    // Start progress bar
    const sortControls = container.querySelector('.follows-sort-controls') as HTMLElement;
    const progressBar = sortControls ? new ProgressBarHelper(sortControls) : null;
    progressBar?.start();

    const list = container.querySelector('.follows-list') as HTMLElement;
    if (!list) return;

    const totalItems = this.allItemsWithProfiles.length;

    // Load all remaining batches
    while (this.hasMore && !this.isLoading) {
      await this.loadBatch(list);

      // Update progress bar
      if (progressBar && totalItems > 0) {
        const progress = (this.currentOffset / totalItems) * 100;
        progressBar.update(progress);
      }

      // Small delay to prevent UI freezing
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    this.isFullyLoaded = true;
    this.isLoadingAll = false;

    // Complete progress bar with fade-out
    progressBar?.complete();

    // Update UI
    if (loadAllLink) {
      loadAllLink.textContent = 'All loaded';
      loadAllLink.classList.remove('follows-sort-controls__load-all--loading');
      loadAllLink.classList.add('follows-sort-controls__load-all--done');
    }

    // Enable sort controls
    this.updateSortControlsUI(container);
  }

  /**
   * Update sort controls UI state
   */
  private updateSortControlsUI(container: HTMLElement): void {
    const sortDateLink = container.querySelector('.follows-sort-controls__sort-date') as HTMLElement;
    const sortZapsLink = container.querySelector('.follows-sort-controls__sort-zaps') as HTMLElement;
    const searchInput = container.querySelector('.follows-sort-controls__search') as HTMLInputElement;
    const nonMutualsLabel = container.querySelector('.follows-sort-controls__non-mutuals');
    const nonMutualsCheckbox = nonMutualsLabel?.querySelector('input') as HTMLInputElement;

    // Enable Date sort when fully loaded
    if (this.isFullyLoaded) {
      sortDateLink?.classList.remove('follows-sort-controls__link--disabled');

      if (searchInput) {
        searchInput.disabled = false;
        searchInput.classList.remove('follows-sort-controls__search--disabled');
      }
      if (nonMutualsLabel && nonMutualsCheckbox) {
        nonMutualsLabel.classList.remove('follows-sort-controls__non-mutuals--disabled');
        nonMutualsCheckbox.disabled = false;
      }
    }

    // Zaps sort requires both fully loaded AND zap stats loaded
    if (this.isFullyLoaded && this.zapStatsLoaded) {
      sortZapsLink?.classList.remove('follows-sort-controls__link--disabled');
    }

    sortDateLink?.classList.toggle('active', this.currentSort === 'date');
    sortZapsLink?.classList.toggle('active', this.currentSort === 'zaps');
  }

  /**
   * Sort items by date (original order - newest first)
   */
  private sortByDate(): void {
    // Reset to original order (newest first based on Kind 3 tag order)
    this.allItemsWithProfiles.sort((a, b) => {
      const indexA = this.originalOrder.indexOf(a.pubkey);
      const indexB = this.originalOrder.indexOf(b.pubkey);
      return indexA - indexB;
    });
  }

  /**
   * Sort items by zap sum (highest first)
   */
  private sortByZaps(): void {
    this.allItemsWithProfiles.sort((a, b) => {
      const statsA = this.zapStatsService.getStats(a.pubkey);
      const statsB = this.zapStatsService.getStats(b.pubkey);

      const sumA = (statsA?.incomingSats || 0) + (statsA?.outgoingSats || 0);
      const sumB = (statsB?.incomingSats || 0) + (statsB?.outgoingSats || 0);

      return sumB - sumA; // Highest first
    });
  }

  /**
   * Render article notification label if user is subscribed
   */
  private renderArticleNotifLabel(pubkey: string): string {
    const articleNotifService = ArticleNotificationService.getInstance();
    if (articleNotifService.isSubscribed(pubkey)) {
      return '<span class="article-notif-label">(Article alerts)</span>';
    }
    return '';
  }
}
