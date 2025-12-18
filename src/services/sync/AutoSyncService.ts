/**
 * AutoSyncService
 * Coordinates automatic list synchronization in Easy Mode
 *
 * @purpose Automatically sync lists when changes occur (Easy Mode)
 * @architecture
 *   - Listens to list update events (follow:updated, bookmark:updated, mute:updated)
 *   - On change: 1) Save to file immediately, 2) Publish to relays (debounced)
 *   - On startup: Restore from file or relays if browser empty
 *
 * @used-by Orchestrators emit events, AutoSyncService reacts
 */

import { EventBus } from '../EventBus';
import { ToastService } from '../ToastService';
import { ListSyncManager } from './ListSyncManager';
import { FollowStorageAdapter } from './adapters/FollowStorageAdapter';
import { BookmarkStorageAdapter } from './adapters/BookmarkStorageAdapter';
import { MuteStorageAdapter } from './adapters/MuteStorageAdapter';
import { RestoreListsService } from '../RestoreListsService';
import { AuthService } from '../AuthService';
import { SyncConfirmationModal } from '../../components/modals/SyncConfirmationModal';
import { UserProfileService } from '../UserProfileService';
import { extractDisplayName } from '../../helpers/extractDisplayName';
import { renderUserMention } from '../../helpers/UserMentionHelper';
import { isEasyMode } from '../../helpers/ListSyncButtonsHelper';
import type { FollowItem } from '../storage/FollowFileStorage';
import type { BookmarkItem } from '../storage/BookmarkFileStorage';
import type { MuteItem } from '../../types/BaseListItem';

type ListType = 'follows' | 'bookmarks' | 'mutes';

export class AutoSyncService {
  private static instance: AutoSyncService;

  private eventBus: EventBus;
  private authService: AuthService;
  private restoreService: RestoreListsService;

  // Adapters and managers for each list type
  private followAdapter: FollowStorageAdapter;
  private bookmarkAdapter: BookmarkStorageAdapter;
  private muteAdapter: MuteStorageAdapter;

  private followSyncManager: ListSyncManager<FollowItem>;
  private bookmarkSyncManager: ListSyncManager<BookmarkItem>;
  private muteSyncManager: ListSyncManager<MuteItem>;

  // Debounce timers for relay sync
  private relaySyncTimers: Map<ListType, ReturnType<typeof setTimeout>> = new Map();
  private readonly RELAY_SYNC_DELAY = 2500; // 2.5 seconds

  // Periodic sync interval (5 minutes)
  private periodicSyncInterval: ReturnType<typeof setInterval> | null = null;
  private readonly PERIODIC_SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes

  // Track if startup sync has been done for each list
  private startupSyncDone: Set<ListType> = new Set();

  // Flag to prevent sync loops
  private isSyncing: Set<ListType> = new Set();

  private constructor() {
    this.eventBus = EventBus.getInstance();
    this.authService = AuthService.getInstance();
    this.restoreService = RestoreListsService.getInstance();

    // Initialize adapters
    this.followAdapter = new FollowStorageAdapter();
    this.bookmarkAdapter = new BookmarkStorageAdapter();
    this.muteAdapter = new MuteStorageAdapter();

    // Initialize sync managers
    this.followSyncManager = new ListSyncManager(this.followAdapter);
    this.bookmarkSyncManager = new ListSyncManager(this.bookmarkAdapter);
    this.muteSyncManager = new ListSyncManager(this.muteAdapter);

    this.setupEventListeners();
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
      this.handleListChange('follows');
    });

    this.eventBus.on('bookmark:updated', () => {
      this.handleListChange('bookmarks');
    });

    this.eventBus.on('mute:updated', () => {
      this.handleListChange('mutes');
    });

    this.eventBus.on('mute:thread:updated', () => {
      this.handleListChange('mutes');
    });

    // Reset on logout
    this.eventBus.on('user:logout', () => {
      this.startupSyncDone.clear();
      this.clearAllTimers();
      this.stopPeriodicSync();
    });

    // Start periodic sync on login
    this.eventBus.on('user:login', () => {
      this.startupSyncDone.clear();
      this.clearAllTimers();
      this.startPeriodicSync();
      // Note: Don't do immediate syncFromRelaysAll() here.
      // restoreIfEmpty() already handles startup cascade (browser → file → relays).
      // The periodic sync (5 min) will catch any relay changes.
      // Immediate sync was causing unmute bug: muted users were restored from relay
      // before local changes (unmute) could be published.
    });

    // Listen for mode changes
    this.eventBus.on('list-sync-mode:changed', ({ mode }: { mode: string }) => {
      if (mode === 'easy') {
        this.startPeriodicSync();
      } else {
        this.stopPeriodicSync();
      }
    });

    // Start periodic sync if already logged in and in Easy Mode
    if (this.authService.getCurrentUser() && isEasyMode()) {
      this.startPeriodicSync();
      // Note: No immediate syncFromRelaysAll() - restoreIfEmpty() handles startup
    }
  }

  /**
   * Handle list change event
   * Only acts if Easy Mode is enabled
   */
  private async handleListChange(listType: ListType): Promise<void> {
    if (!isEasyMode()) return;
    if (!this.authService.getCurrentUser()) return;
    if (this.isSyncing.has(listType)) return; // Prevent sync loops

    try {
      this.isSyncing.add(listType);

      // 1. Save to file immediately (backup first!)
      await this.saveToFile(listType);

      // 2. Sync to relays
      // For mutes: sync immediately (no debounce) to prevent unmute bug
      // (if user reloads before relay sync, mute could be restored from relay)
      // For other lists: use debounce to batch rapid changes
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
      const manager = this.getManagerForListType(listType);
      await manager.saveToFile(listType);
    } catch (error) {
      console.error(`[AutoSyncService] Failed to save ${listType} to file:`, error);
      // Don't show toast for background saves - too noisy
    }
  }

  /**
   * Schedule relay sync with debouncing
   */
  private scheduleRelaySync(listType: ListType): void {
    // Clear existing timer
    const existingTimer = this.relaySyncTimers.get(listType);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule new sync
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

    try {
      const manager = this.getManagerForListType(listType);
      await manager.syncToRelays();
    } catch (error) {
      console.error(`[AutoSyncService] Failed to sync ${listType} to relays:`, error);
      // Silent fail - will retry on next change
    }
  }

  /**
   * Perform startup sync for a list type
   * Called by list managers when they initialize
   *
   * @returns RestoreResult with source and item count
   */
  public async syncOnStartup(listType: ListType): Promise<{ source: string; itemCount: number }> {
    if (!isEasyMode()) {
      return { source: 'skipped', itemCount: 0 };
    }

    if (!this.authService.getCurrentUser()) {
      return { source: 'no-user', itemCount: 0 };
    }

    // Only sync once per session per list type
    if (this.startupSyncDone.has(listType)) {
      return { source: 'already-done', itemCount: 0 };
    }

    this.startupSyncDone.add(listType);

    const adapter = this.getAdapterForListType(listType);
    const manager = this.getManagerForListType(listType);

    // Check if browser already has items
    const browserItems = adapter.getBrowserItems();
    if (browserItems.length > 0) {
      return { source: 'browser', itemCount: browserItems.length };
    }

    // Browser is empty - use RestoreListsService cascading restore
    const result = await this.restoreService.restoreIfEmpty(
      manager,
      () => adapter.getBrowserItems(),
      (items) => adapter.setBrowserItems(items),
      this.getDisplayNameForListType(listType)
    );

    // If restored from relays, immediately save to file (create first backup)
    if (result.source === 'relays' && result.itemCount > 0) {
      ToastService.show(
        `App cache empty. No local backup found. Synced ${result.itemCount} ${listType} from Relays.`,
        'info'
      );

      // Save to file immediately after relay restore
      await this.saveToFile(listType);
    }

    return result;
  }

  /**
   * Get the sync manager for a list type
   */
  private getManagerForListType(listType: ListType): ListSyncManager<FollowItem | BookmarkItem | MuteItem> {
    switch (listType) {
      case 'follows':
        return this.followSyncManager as ListSyncManager<FollowItem | BookmarkItem | MuteItem>;
      case 'bookmarks':
        return this.bookmarkSyncManager as ListSyncManager<FollowItem | BookmarkItem | MuteItem>;
      case 'mutes':
        return this.muteSyncManager as ListSyncManager<FollowItem | BookmarkItem | MuteItem>;
    }
  }

  /**
   * Get the adapter for a list type
   */
  private getAdapterForListType(listType: ListType): FollowStorageAdapter | BookmarkStorageAdapter | MuteStorageAdapter {
    switch (listType) {
      case 'follows':
        return this.followAdapter;
      case 'bookmarks':
        return this.bookmarkAdapter;
      case 'mutes':
        return this.muteAdapter;
    }
  }

  /**
   * Get display name for list type (for toasts)
   */
  private getDisplayNameForListType(listType: ListType): string {
    switch (listType) {
      case 'follows':
        return 'Follows';
      case 'bookmarks':
        return 'Bookmarks';
      case 'mutes':
        return 'Mutes';
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
    }
  }

  /**
   * Sync all lists from relays (periodic sync)
   * Uses merge strategy - never deletes, only adds
   */
  private async syncFromRelaysAll(): Promise<void> {
    if (!isEasyMode()) return;
    if (!this.authService.getCurrentUser()) return;

    for (const listType of ['follows', 'bookmarks', 'mutes'] as ListType[]) {
      await this.syncFromRelays(listType);
    }
  }

  /**
   * Sync a single list from relays
   * Auto-merges if only additions, shows modal if removals detected
   */
  private async syncFromRelays(listType: ListType): Promise<void> {
    if (this.isSyncing.has(listType)) return;

    try {
      this.isSyncing.add(listType);

      const manager = this.getManagerForListType(listType);
      const result = await manager.syncFromRelays();

      // Nothing changed
      if (result.diff.added.length === 0 && result.diff.removed.length === 0) {
        return;
      }

      // Only additions - auto-merge silently
      if (result.diff.added.length > 0 && result.diff.removed.length === 0) {
        await manager.applySyncFromRelays('merge', result.relayItems, result.relayContentWasEmpty);
        await this.saveToFile(listType);
        this.eventBus.emit(this.getEventNameForListType(listType));
        return;
      }

      // Removals detected - show modal to let user decide
      if (result.diff.removed.length > 0) {
        const modal = new SyncConfirmationModal({
          listType: this.getDisplayNameForListType(listType),
          added: result.diff.added,
          removed: result.diff.removed,
          getDisplayName: this.getDisplayNameResolver(listType),
          renderItemHtml: this.getItemHtmlRenderer(listType),
          onKeep: async () => {
            // Keep local items + add new from relay
            await manager.applySyncFromRelays('merge', result.relayItems, result.relayContentWasEmpty);
            await this.saveToFile(listType);
            this.eventBus.emit(this.getEventNameForListType(listType));
            ToastService.show(`${this.getDisplayNameForListType(listType)}: Merged ${result.diff.added.length} new, kept ${result.diff.removed.length} local`, 'success');
          },
          onDelete: async () => {
            // Replace with relay items
            await manager.applySyncFromRelays('overwrite', result.relayItems, result.relayContentWasEmpty);
            await this.saveToFile(listType);
            this.eventBus.emit(this.getEventNameForListType(listType));
            ToastService.show(`${this.getDisplayNameForListType(listType)}: Synced from relays (removed ${result.diff.removed.length})`, 'success');
          }
        });

        await modal.show();
      }
    } catch (error) {
      console.error(`[AutoSyncService] Periodic sync failed for ${listType}:`, error);
    } finally {
      this.isSyncing.delete(listType);
    }
  }

  /**
   * Get display name resolver for sync confirmation modal
   */
  private getDisplayNameResolver(listType: ListType): (item: FollowItem | BookmarkItem | MuteItem) => Promise<string> {
    const userProfileService = UserProfileService.getInstance();

    return async (item: FollowItem | BookmarkItem | MuteItem): Promise<string> => {
      try {
        switch (listType) {
          case 'follows': {
            const followItem = item as FollowItem;
            const profile = await userProfileService.getUserProfile(followItem.pubkey);
            return extractDisplayName(profile);
          }
          case 'bookmarks': {
            const bookmarkItem = item as BookmarkItem;
            // For bookmarks, just show truncated ID
            return bookmarkItem.id.slice(0, 12) + '...';
          }
          case 'mutes': {
            const muteItem = item as MuteItem;
            if (muteItem.type === 'user') {
              const profile = await userProfileService.getUserProfile(muteItem.id);
              return extractDisplayName(profile);
            }
            // Thread mute
            return 'Thread: ' + muteItem.id.slice(0, 12) + '...';
          }
          default:
            return String(item);
        }
      } catch {
        // Fallback to ID
        const id = (item as FollowItem).pubkey || (item as BookmarkItem | MuteItem).id;
        return id?.slice(0, 12) + '...' || 'Unknown';
      }
    };
  }

  /**
   * Get HTML renderer for sync confirmation modal (for mentions with avatar)
   */
  private getItemHtmlRenderer(listType: ListType): (item: FollowItem | BookmarkItem | MuteItem) => Promise<string> {
    const userProfileService = UserProfileService.getInstance();

    return async (item: FollowItem | BookmarkItem | MuteItem): Promise<string> => {
      try {
        switch (listType) {
          case 'follows': {
            const followItem = item as FollowItem;
            const profile = await userProfileService.getUserProfile(followItem.pubkey);
            const username = extractDisplayName(profile);
            const avatarUrl = profile?.picture || '';
            return renderUserMention(followItem.pubkey, { username, avatarUrl });
          }
          case 'mutes': {
            const muteItem = item as MuteItem;
            if (muteItem.type === 'user') {
              const profile = await userProfileService.getUserProfile(muteItem.id);
              const username = extractDisplayName(profile);
              const avatarUrl = profile?.picture || '';
              return renderUserMention(muteItem.id, { username, avatarUrl });
            }
            // Thread mute - no HTML, just text
            return 'Thread: ' + muteItem.id.slice(0, 12) + '...';
          }
          case 'bookmarks':
          default:
            // Bookmarks don't have user mentions, return empty to use text fallback
            return '';
        }
      } catch {
        return '';
      }
    };
  }

  /**
   * Get event name for list type
   */
  private getEventNameForListType(listType: ListType): string {
    switch (listType) {
      case 'follows':
        return 'follow:updated';
      case 'bookmarks':
        return 'bookmark:updated';
      case 'mutes':
        return 'mute:updated';
    }
  }

  /**
   * Force sync all lists now (for testing/manual trigger)
   */
  public async forceSyncAll(): Promise<void> {
    if (!isEasyMode()) return;
    if (!this.authService.getCurrentUser()) return;

    this.clearAllTimers();

    for (const listType of ['follows', 'bookmarks', 'mutes'] as ListType[]) {
      await this.saveToFile(listType);
      await this.syncToRelays(listType);
    }

    ToastService.show('All lists synced', 'success');
  }
}
