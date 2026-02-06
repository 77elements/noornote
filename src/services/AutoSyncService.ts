/**
 * AutoSyncService
 * Coordinates automatic list synchronization in Easy Mode
 *
 * @purpose Automatically sync lists when changes occur (Easy Mode)
 * @architecture
 *   - Listens to list update events (follow:updated, bookmark:updated, mute:updated, tribe:updated)
 *   - On change: Publish to relays (debounced). Tauri Desktop: also save to file immediately.
 *   - On startup: Sync from relays 10 seconds after login
 *   - Periodic sync: Every 5 minutes from relays
 *   - Offline-aware: Pauses relay sync when offline, resumes when back online
 *   - Web/Phone: No file operations (only relay sync)
 */

import { EventBus } from './EventBus';
import { ToastService } from './ToastService';
import { AuthService } from './AuthService';
import { ConnectivityService } from './ConnectivityService';
import { PlatformService } from './PlatformService';
import { SystemLogger } from '../components/system/SystemLogger';
import { UserProfileService } from './UserProfileService';
import { NoteService } from './NoteService';
import { SyncConfirmationModal } from '../components/modals/SyncConfirmationModal';
import { isEasyMode } from '../helpers/ListSyncMode';
import { extractDisplayName } from '../helpers/extractDisplayName';
import { renderUserMention } from '../helpers/UserMentionHelper';

// Import list functions and adapters
import {
  saveToFile as saveFollowsToFile,
  publishToRelays as publishFollowsToRelays,
  FollowStorageAdapter,
  type FollowItem
} from '../lists/follows';

import {
  saveBookmarksToFile,
  publishBookmarksToRelays,
  BookmarkStorageAdapter,
  applyRelayFetchResult as applyBookmarkRelayResult,
  type BookmarkItem
} from '../lists/bookmarks';

import {
  saveToFile as saveMutesToFile,
  publishToRelays as publishMutesToRelays,
  MuteStorageAdapter
} from '../lists/mutes';

import {
  saveToFile as saveTribesToFile,
  publishToRelays as publishTribesToRelays,
  TribeStorageAdapter,
  applyRelayFetchResult as applyTribeRelayResult,
  type TribeMember
} from '../lists/tribes';

type ListType = 'follows' | 'bookmarks' | 'mutes' | 'tribes';

const LIST_DISPLAY_NAMES: Record<ListType, string> = {
  follows: 'Follows',
  bookmarks: 'Bookmarks',
  mutes: 'Mutes',
  tribes: 'Tribes'
};

export class AutoSyncService {
  private static instance: AutoSyncService;

  private eventBus: EventBus;
  private authService: AuthService;
  private connectivityService: ConnectivityService;
  private systemLogger: SystemLogger;
  private userProfileService: UserProfileService;

  // Adapters for each list type
  private followAdapter: FollowStorageAdapter;
  private bookmarkAdapter: BookmarkStorageAdapter;
  private muteAdapter: MuteStorageAdapter;
  private tribeAdapter: TribeStorageAdapter;

  // Debounce timers for relay sync
  private relaySyncTimers: Map<ListType, ReturnType<typeof setTimeout>> = new Map();
  private readonly RELAY_SYNC_DELAY = 2500; // 2.5 seconds

  // Periodic sync interval (5 minutes)
  private periodicSyncInterval: ReturnType<typeof setInterval> | null = null;
  private readonly PERIODIC_SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes

  // Startup sync delay (10 seconds after login)
  private startupSyncTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly STARTUP_SYNC_DELAY = 10 * 1000; // 10 seconds

  // Flag to prevent sync loops
  private isSyncing: Set<ListType> = new Set();

  private constructor() {
    this.eventBus = EventBus.getInstance();
    this.authService = AuthService.getInstance();
    this.connectivityService = ConnectivityService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.userProfileService = UserProfileService.getInstance();

    // Initialize adapters
    this.followAdapter = new FollowStorageAdapter();
    this.bookmarkAdapter = new BookmarkStorageAdapter();
    this.muteAdapter = new MuteStorageAdapter();
    this.tribeAdapter = new TribeStorageAdapter();

    this.setupEventListeners();
    this.systemLogger.info('ListAutoSync', 'initialized');

    // Direct check: if user already logged in and easy mode, start immediately
    if (this.authService.getCurrentUser() && isEasyMode()) {
      this.systemLogger.info('ListAutoSync', 'User already logged in, starting sync');
      this.scheduleStartupSync();
    }
  }

  public static getInstance(): AutoSyncService {
    if (!AutoSyncService.instance) {
      AutoSyncService.instance = new AutoSyncService();
    }
    return AutoSyncService.instance;
  }

  /**
   * Setup event listeners for list updates
   */
  private setupEventListeners(): void {
    // Listen to list update events
    this.eventBus.on('follow:updated', () => {
      this.systemLogger.info('ListAutoSync', 'follow:updated triggered');
      this.handleListChange('follows');
    });

    this.eventBus.on('bookmark:updated', () => {
      this.systemLogger.info('ListAutoSync', 'bookmark:updated triggered');
      this.handleListChange('bookmarks');
    });

    this.eventBus.on('bookmark:order-changed', () => {
      this.systemLogger.info('ListAutoSync', 'bookmark:order-changed triggered');
      this.handleListChange('bookmarks');
    });

    this.eventBus.on('mute:updated', () => {
      this.systemLogger.info('ListAutoSync', 'mute:updated triggered');
      this.handleListChange('mutes');
    });

    this.eventBus.on('mute:thread:updated', () => {
      this.systemLogger.info('ListAutoSync', 'mute:thread:updated triggered');
      this.handleListChange('mutes');
    });

    this.eventBus.on('tribe:updated', () => {
      this.systemLogger.info('ListAutoSync', 'tribe:updated triggered');
      this.handleListChange('tribes');
    });

    // Reset on logout
    this.eventBus.on('user:logout', () => {
      this.clearAllTimers();
      this.stopPeriodicSync();
      this.cancelStartupSync();
    });

    // Start sync on login
    this.eventBus.on('user:login', () => {
      this.clearAllTimers();
      if (isEasyMode()) {
        this.scheduleStartupSync();
      }
    });

    // Listen for mode changes
    this.eventBus.on('list-sync-mode:changed', ({ mode }: { mode: string }) => {
      if (mode === 'easy') {
        this.scheduleStartupSync();
      } else {
        this.stopPeriodicSync();
        this.cancelStartupSync();
      }
    });

    // Listen for connectivity changes
    this.eventBus.on('connectivity:status', ({ online }: { online: boolean }) => {
      if (online) {
        this.handleBackOnline();
      } else {
        this.handleWentOffline();
      }
    });

    // Start sync if already logged in and in Easy Mode
    // Use delayed check because user:login may have fired before this service initialized
    setTimeout(() => {
      if (this.authService.getCurrentUser() && isEasyMode() && !this.startupSyncTimeout && !this.periodicSyncInterval) {
        this.systemLogger.info('ListAutoSync', 'Delayed init: user is logged in, scheduling startup sync');
        this.scheduleStartupSync();
      }
    }, 2000);
  }

  /**
   * Schedule startup sync (10 seconds after login)
   */
  private scheduleStartupSync(): void {
    this.cancelStartupSync();
    this.systemLogger.info('ListAutoSync', 'Startup sync scheduled in 10 seconds');

    this.startupSyncTimeout = setTimeout(async () => {
      this.systemLogger.info('ListAutoSync', 'Running startup sync');
      await this.syncFromRelaysAll();
      this.startPeriodicSync();
    }, this.STARTUP_SYNC_DELAY);
  }

  /**
   * Cancel scheduled startup sync
   */
  private cancelStartupSync(): void {
    if (this.startupSyncTimeout) {
      clearTimeout(this.startupSyncTimeout);
      this.startupSyncTimeout = null;
    }
  }

  /**
   * Handle went offline
   */
  private handleWentOffline(): void {
    this.stopPeriodicSync();
    this.systemLogger.info('ListAutoSync', 'Offline detected - periodic relay sync paused');
  }

  /**
   * Handle back online
   */
  private handleBackOnline(): void {
    if (isEasyMode() && this.authService.getCurrentUser()) {
      this.startPeriodicSync();
      this.systemLogger.info('ListAutoSync', 'Back online - resuming periodic sync and catching up');
      this.syncFromRelaysAll();
    }
  }

  /**
   * Handle list change event
   * Only acts if Easy Mode is enabled
   */
  private async handleListChange(listType: ListType): Promise<void> {
    if (!isEasyMode()) return;
    if (!this.authService.getCurrentUser()) return;
    if (this.isSyncing.has(listType)) return;

    try {
      this.isSyncing.add(listType);

      // 1. Save to file immediately (Tauri Desktop only - Web/Phone has no file system)
      if (PlatformService.getInstance().isTauri) {
        await this.saveToFile(listType);
      }

      // 2. Sync to relays
      // For mutes: sync immediately (no debounce) to prevent unmute bug
      if (listType === 'mutes') {
        await this.syncToRelays(listType);
      } else {
        this.scheduleRelaySync(listType);
      }
    } finally {
      this.isSyncing.delete(listType);
    }
  }

  /**
   * Save list to local file immediately
   */
  private async saveToFile(listType: ListType): Promise<void> {
    try {
      switch (listType) {
        case 'follows':
          await saveFollowsToFile();
          break;
        case 'bookmarks':
          await saveBookmarksToFile();
          break;
        case 'mutes':
          await saveMutesToFile();
          break;
        case 'tribes':
          await saveTribesToFile();
          break;
      }
      this.systemLogger.info('ListAutoSync', `${listType}: saved to file`);
    } catch (error) {
      this.systemLogger.error('ListAutoSync', `${listType}: save to file failed: ${error}`);
    }
  }

  /**
   * Schedule relay sync with debouncing
   */
  private scheduleRelaySync(listType: ListType): void {
    const existingTimer = this.relaySyncTimers.get(listType);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      await this.syncToRelays(listType);
      this.relaySyncTimers.delete(listType);
    }, this.RELAY_SYNC_DELAY);

    this.relaySyncTimers.set(listType, timer);
  }

  /**
   * Sync list to relays
   */
  private async syncToRelays(listType: ListType): Promise<void> {
    if (!this.authService.getCurrentUser()) return;

    if (!this.connectivityService.isOnline()) {
      this.systemLogger.info('ListAutoSync', `${listType}: relay sync skipped (offline)`);
      return;
    }

    this.systemLogger.info('ListAutoSync', 'Lists in Easy Mode. AutoSync triggered to relays.');

    try {
      switch (listType) {
        case 'follows':
          await publishFollowsToRelays();
          break;
        case 'bookmarks':
          await publishBookmarksToRelays();
          break;
        case 'mutes':
          await publishMutesToRelays();
          break;
        case 'tribes':
          await publishTribesToRelays();
          break;
      }
      this.systemLogger.info('ListAutoSync', `${listType}: synced to relays`);
    } catch (error) {
      this.systemLogger.error('ListAutoSync', `${listType}: relay sync failed: ${error}`);
    }
  }

  /**
   * Clear all pending timers
   */
  private clearAllTimers(): void {
    for (const timer of this.relaySyncTimers.values()) {
      clearTimeout(timer);
    }
    this.relaySyncTimers.clear();
  }

  /**
   * Start periodic sync from relays (every 5 minutes)
   */
  private startPeriodicSync(): void {
    if (!isEasyMode()) return;
    if (this.periodicSyncInterval) return; // Already running

    this.systemLogger.info('ListAutoSync', 'Starting periodic sync (every 5 minutes)');

    this.periodicSyncInterval = setInterval(() => {
      this.syncFromRelaysAll();
    }, this.PERIODIC_SYNC_INTERVAL);
  }

  /**
   * Stop periodic sync
   */
  private stopPeriodicSync(): void {
    if (this.periodicSyncInterval) {
      clearInterval(this.periodicSyncInterval);
      this.periodicSyncInterval = null;
      this.systemLogger.info('ListAutoSync', 'Periodic sync stopped');
    }
  }

  /**
   * Sync all lists from relays
   */
  private async syncFromRelaysAll(): Promise<void> {
    if (!isEasyMode()) return;
    if (!this.authService.getCurrentUser()) return;

    if (!this.connectivityService.isOnline()) {
      this.systemLogger.info('ListAutoSync', 'Skipping periodic relay sync - offline');
      return;
    }

    this.systemLogger.info('ListAutoSync', 'Lists in Easy Mode. AutoSync triggered from relays.');

    for (const listType of ['follows', 'bookmarks', 'mutes', 'tribes'] as ListType[]) {
      await this.syncFromRelays(listType);
    }
  }

  /**
   * Sync a single list from relays
   */
  private async syncFromRelays(listType: ListType): Promise<void> {
    if (!this.connectivityService.isOnline()) return;
    if (this.isSyncing.has(listType)) return;

    try {
      this.isSyncing.add(listType);
      this.systemLogger.info('ListAutoSync', `${listType}: fetching from relays...`);

      const result = await this.fetchAndCompare(listType);
      if (!result) {
        this.systemLogger.warn('ListAutoSync', `${listType}: fetch returned null`);
        return;
      }

      this.systemLogger.info('ListAutoSync', `${listType}: diff - added: ${result.diff.added.length}, removed: ${result.diff.removed.length}`);

      // Nothing changed - skip
      const movedCount = result.diff.moved?.length || 0;
      if (result.diff.added.length === 0 && result.diff.removed.length === 0 && movedCount === 0) {
        return;
      }

      // Simple case: only new items from relay, nothing removed or moved
      // → auto-merge without bothering the user
      if (result.diff.added.length > 0 && result.diff.removed.length === 0 && movedCount === 0) {
        this.systemLogger.info('ListAutoSync', `${listType}: auto-merging ${result.diff.added.length} new items`);
        this.applyMerge(listType, result.relayItems);
        if ((listType === 'bookmarks' || listType === 'tribes') && result.categoryAssignments) {
          await this.applyFolderAssignments(listType, result);
        }
        ToastService.show(`${LIST_DISPLAY_NAMES[listType]}: ${result.diff.added.length} new synced from relay`, 'success');
        return;
      }

      // Complex case (removals, moves) - show modal to let user decide
      this.systemLogger.info('ListAutoSync', `${listType}: showing merge modal`);
      await this.showSyncConfirmationModal(listType, result);
    } catch (error) {
      this.systemLogger.error('ListAutoSync', `Periodic sync failed for ${listType}: ${error}`);
    } finally {
      this.isSyncing.delete(listType);
    }
  }

  /**
   * Fetch from relays and compare with browser items
   */
  private async fetchAndCompare(listType: ListType): Promise<SyncResult | null> {
    try {
      switch (listType) {
        case 'follows': {
          const result = await this.followAdapter.syncFromRelays();
          return {
            diff: { added: result.diff.added, removed: result.diff.removed },
            relayItems: result.relayItems,
            relayContentWasEmpty: result.relayContentWasEmpty,
            categoryAssignments: undefined,
            categories: undefined
          };
        }

        case 'bookmarks': {
          const result = await this.bookmarkAdapter.syncFromRelays();
          return {
            diff: { added: result.diff.added, removed: result.diff.removed, moved: result.diff.moved },
            relayItems: result.relayItems,
            relayContentWasEmpty: result.relayContentWasEmpty,
            categoryAssignments: result.categoryAssignments,
            categories: result.categories
          };
        }

        case 'mutes': {
          const result = await this.muteAdapter.syncFromRelays();
          return {
            diff: { added: result.diff.added, removed: result.diff.removed },
            relayItems: result.relayItems,
            relayContentWasEmpty: result.relayContentWasEmpty,
            categoryAssignments: undefined,
            categories: undefined
          };
        }

        case 'tribes': {
          const result = await this.tribeAdapter.syncFromRelays();
          return {
            diff: { added: result.diff.added, removed: result.diff.removed, moved: result.diff.moved },
            relayItems: result.relayItems,
            relayContentWasEmpty: result.relayContentWasEmpty,
            categoryAssignments: result.categoryAssignments,
            categories: result.categories
          };
        }
      }
    } catch (error) {
      this.systemLogger.error('ListAutoSync', `Failed to fetch ${listType} from relays: ${error}`);
      return null;
    }
  }

  /**
   * Apply merge strategy (keep browser + add new from relay)
   */
  private applyMerge(listType: ListType, relayItems: unknown[]): void {
    switch (listType) {
      case 'follows':
        this.followAdapter.applySyncFromRelays('merge', relayItems as FollowItem[], false);
        break;
      case 'bookmarks':
        this.bookmarkAdapter.applySyncFromRelays('merge', relayItems as BookmarkItem[]);
        break;
      case 'mutes':
        this.muteAdapter.applySyncFromRelays('merge', relayItems as string[]);
        break;
      case 'tribes':
        this.tribeAdapter.applySyncFromRelays('merge', relayItems as TribeMember[]);
        break;
    }
  }

  /**
   * Apply overwrite strategy (replace browser with relay)
   */
  private applyOverwrite(listType: ListType, relayItems: unknown[], relayContentWasEmpty: boolean): void {
    switch (listType) {
      case 'follows':
        this.followAdapter.applySyncFromRelays('overwrite', relayItems as FollowItem[], relayContentWasEmpty);
        break;
      case 'bookmarks':
        this.bookmarkAdapter.applySyncFromRelays('overwrite', relayItems as BookmarkItem[]);
        break;
      case 'mutes':
        this.muteAdapter.applySyncFromRelays('overwrite', relayItems as string[]);
        break;
      case 'tribes':
        this.tribeAdapter.applySyncFromRelays('overwrite', relayItems as TribeMember[]);
        break;
    }
  }

  /**
   * Apply folder assignments for bookmarks/tribes
   */
  private async applyFolderAssignments(listType: ListType, result: SyncResult): Promise<void> {
    if (listType === 'bookmarks' && result.categoryAssignments) {
      applyBookmarkRelayResult(
        result.relayItems as BookmarkItem[],
        result.categoryAssignments,
        result.categories
      );
    }

    if (listType === 'tribes' && result.categoryAssignments) {
      applyTribeRelayResult(
        result.relayItems as TribeMember[],
        result.categoryAssignments,
        result.categories
      );
    }
  }

  /**
   * Show sync confirmation modal
   */
  private async showSyncConfirmationModal(listType: ListType, result: SyncResult): Promise<void> {
    // Transform moved items for the modal format
    interface MovedRaw { browserItem?: { category?: string }; sourceItem?: { category?: string } }
    const rawMoved = (result.diff.moved || []) as MovedRaw[];
    const movedForModal = rawMoved.map(m => ({
      item: m.browserItem as unknown,
      browserFolder: (m.browserItem?.category) || '(root)',
      sourceFolder: (m.sourceItem?.category) || '(root)'
    }));

    const modal = new SyncConfirmationModal({
      listType: LIST_DISPLAY_NAMES[listType],
      added: result.diff.added,
      removed: result.diff.removed,
      ...(movedForModal.length > 0 && { moved: movedForModal }),
      getDisplayName: async (item: unknown) => this.getDisplayName(listType, item),
      renderItemHtml: async (item: unknown) => this.renderItemHtml(listType, item),
      onKeep: async () => {
        // Keep local state as-is, only add new items from relay (no push back)
        this.applyMerge(listType, result.relayItems);
        if ((listType === 'bookmarks' || listType === 'tribes') && result.categoryAssignments) {
          await this.applyFolderAssignments(listType, result);
        }
        ToastService.show(`${LIST_DISPLAY_NAMES[listType]}: Added ${result.diff.added.length} new, kept ${result.diff.removed.length} local`, 'success');
      },
      onMerge: async () => {
        // True merge: combine both local + relay, then push back to relays
        this.applyMerge(listType, result.relayItems);
        if ((listType === 'bookmarks' || listType === 'tribes') && result.categoryAssignments) {
          await this.applyFolderAssignments(listType, result);
        }
        // Push merged state back to relays
        await this.syncToRelays(listType);
        ToastService.show(`${LIST_DISPLAY_NAMES[listType]}: Merged and synced to relays`, 'success');
      },
      onDelete: async () => {
        this.applyOverwrite(listType, result.relayItems, result.relayContentWasEmpty);
        if ((listType === 'bookmarks' || listType === 'tribes') && result.categoryAssignments) {
          await this.applyFolderAssignments(listType, result);
        }
        ToastService.show(`${LIST_DISPLAY_NAMES[listType]}: Synced from relays (removed ${result.diff.removed.length})`, 'success');
      }
    });

    await modal.show();
  }

  /**
   * Get display name for an item
   */
  private async getDisplayName(listType: ListType, item: unknown): Promise<string> {
    try {
      switch (listType) {
        case 'follows': {
          const followItem = item as FollowItem;
          const profile = await this.userProfileService.getUserProfile(followItem.pubkey);
          return extractDisplayName(profile);
        }

        case 'bookmarks': {
          const bookmarkItem = item as BookmarkItem;

          // Handle different bookmark types
          if (bookmarkItem.type === 'r') {
            // URL bookmark - show the URL directly
            return bookmarkItem.value || bookmarkItem.id;
          }

          if (bookmarkItem.type === 't') {
            // Hashtag bookmark
            return `#${bookmarkItem.value || bookmarkItem.id}`;
          }

          // Event or article bookmark - try to fetch note content
          if (bookmarkItem.type === 'e' || bookmarkItem.type === 'a') {
            const noteService = NoteService.getInstance();
            const event = await noteService.getNote(bookmarkItem.id);
            if (event?.content) {
              return event.content.slice(0, 60) || bookmarkItem.id.slice(0, 12) + '...';
            }
          }

          return bookmarkItem.id.slice(0, 12) + '...';
        }

        case 'mutes': {
          const encoded = item as string;
          // Handle prefixed format: p:pubkey for users, e:eventid for threads
          if (encoded.startsWith('p:')) {
            const pubkey = encoded.slice(2);
            const profile = await this.userProfileService.getUserProfile(pubkey);
            return extractDisplayName(profile);
          }
          if (encoded.startsWith('e:')) {
            const eventId = encoded.slice(2);
            const noteService = NoteService.getInstance();
            const event = await noteService.getNote(eventId);
            if (event?.content) {
              return `Thread: ${event.content.slice(0, 40)}...`;
            }
            return `Thread: ${eventId.slice(0, 12)}...`;
          }
          // Legacy format (no prefix) - treat as pubkey
          const profile = await this.userProfileService.getUserProfile(encoded);
          return extractDisplayName(profile);
        }

        case 'tribes': {
          const tribeItem = item as TribeMember;
          const profile = await this.userProfileService.getUserProfile(tribeItem.pubkey);
          return extractDisplayName(profile);
        }
      }
    } catch {
      if (typeof item === 'string') {
        return item.slice(0, 12) + '...';
      }
      const pubkey = (item as FollowItem | TribeMember).pubkey || (item as BookmarkItem).id;
      return pubkey?.slice(0, 12) + '...' || 'Unknown';
    }
  }

  /**
   * Render item as HTML (for mentions with avatar)
   */
  private async renderItemHtml(listType: ListType, item: unknown): Promise<string> {
    try {
      let pubkey: string | null = null;

      switch (listType) {
        case 'follows':
          pubkey = (item as FollowItem).pubkey;
          break;
        case 'tribes':
          pubkey = (item as TribeMember).pubkey;
          break;
        case 'mutes': {
          const encoded = item as string;
          // Handle prefixed format: p:pubkey for users, e:eventid for threads
          if (encoded.startsWith('p:')) {
            pubkey = encoded.slice(2);
          } else if (encoded.startsWith('e:')) {
            // Threads don't have avatars - return text-only display
            const eventId = encoded.slice(2);
            const noteService = NoteService.getInstance();
            const event = await noteService.getNote(eventId);
            const content = event?.content?.slice(0, 40) || eventId.slice(0, 12);
            return `<span class="sync-item-thread">🔇 Thread: ${this.escapeHtml(content)}...</span>`;
          } else {
            // Legacy format (no prefix) - treat as pubkey
            pubkey = encoded;
          }
          break;
        }
        case 'bookmarks':
          return ''; // Bookmarks don't have user mentions
      }

      if (pubkey) {
        const profile = await this.userProfileService.getUserProfile(pubkey);
        const username = extractDisplayName(profile);
        const avatarUrl = profile?.picture || '';
        return renderUserMention(pubkey, { username, avatarUrl });
      }
      return '';
    } catch {
      return '';
    }
  }

  /**
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Internal type for sync results
interface SyncResult {
  diff: { added: unknown[]; removed: unknown[]; moved?: unknown[] };
  relayItems: unknown[];
  relayContentWasEmpty: boolean;
  categoryAssignments: Map<string, string> | undefined;
  categories: string[] | undefined;
}
