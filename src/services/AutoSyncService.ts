/**
 * AutoSyncService
 * Coordinates automatic list synchronization in Easy Mode
 *
 * @purpose Automatically sync lists when changes occur (Easy Mode)
 * @architecture
 *   - Listens to list update events (follow:updated, bookmark:updated, mute:updated, tribe:updated)
 *   - On change: Publish to relays (debounced). Desktop: also save to file immediately.
 *   - On startup: Sync from relays 10 seconds after login
 *   - Periodic sync: Every 5 minutes from relays
 *   - Offline-aware: Pauses relay sync when offline, resumes when back online
 *   - Web/Phone: No file operations (only relay sync)
 */

import { TypedEventBus } from '../core/TypedEventBus';
import { getListLastModified, setListLastModified, type ListType as StorageListType } from '../lists/storage';
import { AuthService } from './AuthService';
import { ConnectivityService } from './ConnectivityService';
import { PlatformService } from './PlatformService';
import { SystemLogger } from './SystemLogger';
import { isEasyMode } from '../helpers/ListSyncMode';
import { diagLog } from './DiagnosticLogger';
import { AddonLoader } from '../addons/AddonLoader';
import type { NospressRuntime } from '../addons/nospress/runtime';

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
import { isBookmarksEnabled } from '../addons/bookmarks/index';
import { isTribesEnabled } from '../addons/tribes/index';
import { isDataSaverEnabled } from './DataSaverService';

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

export class AutoSyncService {
  private static instance: AutoSyncService;

  private eventBus: TypedEventBus;
  private authService: AuthService;
  private connectivityService: ConnectivityService;
  private systemLogger: SystemLogger;
  // UserProfileService removed — no longer needed for Easy Mode (no modal)

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
  private readonly PERIODIC_SYNC_INTERVAL = isDataSaverEnabled() ? 15 * 60 * 1000 : 5 * 60 * 1000;

  // Startup sync delay (10 seconds after login)
  private startupSyncTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly STARTUP_SYNC_DELAY = 10 * 1000; // 10 seconds

  // Flag to prevent sync loops
  private isSyncing: Set<ListType> = new Set();

  private constructor() {
    this.eventBus = TypedEventBus.getInstance();
    this.authService = AuthService.getInstance();
    this.connectivityService = ConnectivityService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    // UserProfileService no longer needed (no modal in Easy Mode)

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
      if (this.authService.getCurrentUser() && isEasyMode() && !this.authService.isBunkerAuth() && !this.startupSyncTimeout && !this.periodicSyncInterval) {
        this.systemLogger.info('ListAutoSync', 'Delayed init: user is logged in, scheduling startup sync');
        this.scheduleStartupSync();
      }
    }, 2000);
  }

  /**
   * Schedule startup sync (10 seconds after login)
   */
  private scheduleStartupSync(): void {
    if (this.authService.isBunkerAuth()) return;
    this.cancelStartupSync();
    this.systemLogger.info('ListAutoSync', 'Startup sync scheduled in 10 seconds');

    this.startupSyncTimeout = setTimeout(async () => {
      this.systemLogger.info('ListAutoSync', 'Running startup sync');
      await this.syncFromRelaysAll();
      this.startPeriodicSync();

      // ProfileMounts sync (independent of the NosPress addon).
      try {
        const { ProfileMountsOrchestrator } = await import('./orchestration/ProfileMountsOrchestrator');
        await ProfileMountsOrchestrator.getInstance().syncFromRelays();
      } catch {
        // ProfileMounts sync failed silently
      }

      // NosPress sync — only when the addon runtime is loaded. The 10s
      // startup delay above gives AddonLoader plenty of time to activate
      // the runtime via the user:login event before this code runs.
      try {
        const runtime = AddonLoader.getInstance().getRuntime<NospressRuntime>('nospress');
        if (runtime) {
          await Promise.all([
            runtime.mounts?.syncFromRelays(),
            runtime.nospress?.syncFromRelays(),
          ]);
        }
      } catch {
        // NosPress sync failed silently
      }
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
    // Skip sync for disabled addons (data stays in localStorage, just no sync)
    if (listType === 'bookmarks' && !isBookmarksEnabled()) return;
    if (listType === 'tribes' && !isTribesEnabled()) return;
    if (this.isSyncing.has(listType)) {
      diagLog('lists', `handleListChange(${listType}): BLOCKED by isSyncing`, { currentlySyncing: [...this.isSyncing] });
      return;
    }
    diagLog('lists', `handleListChange(${listType}): proceeding`, { isSyncingSet: [...this.isSyncing] });

    try {
      this.isSyncing.add(listType);

      // 0. Update local timestamp
      setListLastModified(listType as StorageListType);

      // 1. Save to file immediately (Desktop only - Web/Phone has no file system)
      const _p = PlatformService.getInstance();
      if (_p.isDesktop) {
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
    diagLog('lists', `scheduleRelaySync(${listType}): scheduling`, { delayMs: this.RELAY_SYNC_DELAY });
    const existingTimer = this.relaySyncTimers.get(listType);
    if (existingTimer) {
      diagLog('lists', `scheduleRelaySync(${listType}): clearing existing timer`);
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      this.relaySyncTimers.delete(listType);
      if (this.isSyncing.has(listType)) return; // Don't push while a sync is running
      await this.syncToRelays(listType);
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
      diagLog('lists', `syncToRelays(${listType}): BEFORE publish`);
      switch (listType) {
        case 'follows':
          await publishFollowsToRelays();
          break;
        case 'bookmarks':
          await publishBookmarksToRelays('autosync-push');
          break;
        case 'mutes':
          await publishMutesToRelays();
          break;
        case 'tribes':
          await publishTribesToRelays();
          break;
      }
      diagLog('lists', `syncToRelays(${listType}): AFTER publish — success`);
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
   * Trigger sync for a single list after addon activation.
   * Runs with a 10-second delay (like startup sync) to avoid hammering relays.
   */
  public scheduleSyncForList(listType: ListType): void {
    if (!isEasyMode()) return;
    if (!this.authService.getCurrentUser()) return;

    this.systemLogger.info('ListAutoSync', `${listType}: addon activated, scheduling sync in 10s`);
    setTimeout(() => {
      this.syncFromRelays(listType);
    }, 10000);
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
    diagLog('lists', 'syncFromRelaysAll(): starting sync for all list types');

    const listsToSync: ListType[] = ['follows', 'mutes'];
    if (isBookmarksEnabled()) listsToSync.push('bookmarks');
    if (isTribesEnabled()) listsToSync.push('tribes');

    for (const listType of listsToSync) {
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
        diagLog('lists', `syncFromRelays(${listType}): fetchAndCompare returned null — aborting`);
        this.systemLogger.warn('ListAutoSync', `${listType}: fetch returned null`);
        return;
      }

      diagLog('lists', `syncFromRelays(${listType}): fetchAndCompare result`, {
        addedCount: result.diff.added.length,
        removedCount: result.diff.removed.length,
        movedCount: result.diff.moved?.length || 0,
        relayItemsCount: result.relayItems.length,
        relayContentWasEmpty: result.relayContentWasEmpty,
        requiresConfirmation: result.requiresConfirmation,
        hasCategoryAssignments: !!result.categoryAssignments,
        categories: result.categories
      });
      diagLog('lists', `syncFromRelays(${listType}): diff.added`, { items: result.diff.added });
      diagLog('lists', `syncFromRelays(${listType}): diff.removed`, { items: result.diff.removed });
      if (result.diff.moved?.length) {
        diagLog('lists', `syncFromRelays(${listType}): diff.moved`, { items: result.diff.moved });
      }

      this.systemLogger.info('ListAutoSync', `${listType}: diff - added: ${result.diff.added.length}, removed: ${result.diff.removed.length}`);

      // Safety: relay returned empty but we have local items — skip
      if (result.relayContentWasEmpty && result.diff.removed.length > 0) {
        diagLog('lists', `syncFromRelays(${listType}): relay empty safety — skipping`);
        this.systemLogger.warn('ListAutoSync', `${listType}: relay returned empty, skipping`);
        return;
      }

      // No differences at all
      if (!result.requiresConfirmation && result.diff.added.length === 0 && result.diff.removed.length === 0 && (result.diff.moved?.length || 0) === 0) {
        diagLog('lists', `syncFromRelays(${listType}): no changes`);
        return;
      }

      // Timestamp-based sync: newest version wins
      const localTs = getListLastModified(listType as StorageListType);
      const relayTs = this.getRelayTimestamp(result);

      diagLog('lists', `syncFromRelays(${listType}): timestamp compare`, { localTs, relayTs, localISO: new Date(localTs * 1000).toISOString(), relayISO: new Date(relayTs * 1000).toISOString() });

      if (relayTs > localTs) {
        // Relay is newer → apply relay version
        diagLog('lists', `syncFromRelays(${listType}): relay is newer — applying`);
        this.systemLogger.info('ListAutoSync', `${listType}: relay is newer, applying`);

        // RESURRECTION DETECTION (logging only, no behavior change) — see docs/features/lists.md "Folder-Resurrection"
        // Capture browser folder names BEFORE the destructive apply, then warn if relay introduces new ones
        let browserFoldersBefore: string[] = [];
        if (listType === 'tribes') {
          const { getFolders } = await import('../lists/tribes');
          browserFoldersBefore = getFolders().map(f => f.name);
        } else if (listType === 'bookmarks') {
          const { getBookmarkFolderService } = await import('../lists/bookmarks');
          browserFoldersBefore = getBookmarkFolderService().getFolders().map(f => f.name);
        }

        // SANITY-CHECK (Schritt 1.5, 2026-04-30 — see docs/features/lists.md "Mass-Deletion Incident"):
        // Refuse a silent applyOverwrite that would remove a folder for which we have NO kind:5
        // deletion proof in this fetch. Cause: NDK fetch-instability returned an incomplete folder
        // list, and applyOverwrite would have wiped them locally. With Schritt 1 in place, every
        // legitimate folder delete is accompanied by an eager kind:5 — its absence here means
        // the fetch is incomplete, not that the user deleted. Skip and let the next sync retry
        // with a (hopefully) complete fetch.
        if (listType === 'bookmarks' && result.diff.removed.length > 0 && result.categories && result.deletedCoordinates) {
          const relayFolderSet = new Set(result.categories);
          const removedFolders = browserFoldersBefore.filter(f => !relayFolderSet.has(f));
          if (removedFolders.length > 0) {
            // Extract folder names from coordinate keys "30003:<pubkey>:<folderName>"
            const deletedFolderNames = new Set(
              Array.from(result.deletedCoordinates.keys())
                .map(c => c.split(':').slice(2).join(':'))
            );
            const unmarkedRemovals = removedFolders.filter(f => !deletedFolderNames.has(f));
            if (unmarkedRemovals.length > 0) {
              diagLog('lists', `applyOverwrite(${listType}): refused — silent removal without deletion proof`, {
                removedFolders,
                unmarkedRemovals,
                relayCategories: result.categories,
                deletedCoordinates: Array.from(result.deletedCoordinates.keys()),
                relayTs,
                localTs
              });
              this.systemLogger.warn('ListAutoSync', `${listType}: refusing applyOverwrite — ${unmarkedRemovals.length} folder(s) would be silently removed without kind:5 evidence (likely incomplete fetch). Will retry on next sync.`);
              return;
            }
          }
        }

        this.applyOverwrite(listType, result.relayItems, result.relayContentWasEmpty);
        if ((listType === 'bookmarks' || listType === 'tribes') && result.categoryAssignments) {
          await this.applyFolderAssignments(listType, result);
        }
        if (listType === 'bookmarks' && result.categories) {
          const { applyRelayFolderOrder } = await import('../lists/bookmarks');
          applyRelayFolderOrder(result.categories);
        }
        setListLastModified(listType as StorageListType, relayTs);

        // Compare browser folder state AFTER apply — anything new = potential resurrection
        if (browserFoldersBefore.length > 0 && (listType === 'tribes' || listType === 'bookmarks')) {
          let browserFoldersAfter: string[] = [];
          if (listType === 'tribes') {
            const { getFolders } = await import('../lists/tribes');
            browserFoldersAfter = getFolders().map(f => f.name);
          } else {
            const { getBookmarkFolderService } = await import('../lists/bookmarks');
            browserFoldersAfter = getBookmarkFolderService().getFolders().map(f => f.name);
          }
          const beforeSet = new Set(browserFoldersBefore);
          const newlyAppearedFolders = browserFoldersAfter.filter(f => !beforeSet.has(f));
          if (newlyAppearedFolders.length > 0) {
            console.debug(`[Lists] Possible folder resurrection in ${listType} — folders appeared after applyOverwrite that did not exist before`, {
              newlyAppearedFolders,
              browserFoldersBefore,
              browserFoldersAfter,
              relayTs,
              localTs
            });
            diagLog('lists', `${listType} RESURRECTION CANDIDATE in applyOverwrite/applyFolderAssignments`, {
              newlyAppearedFolders,
              browserFoldersBefore,
              browserFoldersAfter,
              relayTs,
              localTs
            });
          }
        }
      } else {
        // Local is newer or equal → push local to relay
        diagLog('lists', `syncFromRelays(${listType}): local is newer — pushing`);
        this.systemLogger.info('ListAutoSync', `${listType}: local is newer, pushing to relay`);
        await this.syncToRelays(listType);
      }
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
          diagLog('lists', 'fetchAndCompare(follows): raw adapter result', { diffAdded: result.diff.added.length, diffRemoved: result.diff.removed.length, relayItems: result.relayItems.length, relayContentWasEmpty: result.relayContentWasEmpty, requiresConfirmation: result.requiresConfirmation });
          return {
            diff: { added: result.diff.added, removed: result.diff.removed },
            relayItems: result.relayItems,
            relayContentWasEmpty: result.relayContentWasEmpty,
            requiresConfirmation: result.requiresConfirmation,
            relayTimestamp: result.relayTimestamp,
            categoryAssignments: undefined,
            categories: undefined
          };
        }

        case 'bookmarks': {
          const result = await this.bookmarkAdapter.syncFromRelays();
          diagLog('lists', 'fetchAndCompare(bookmarks): raw adapter result', { diffAdded: result.diff.added.length, diffRemoved: result.diff.removed.length, diffMoved: result.diff.moved?.length || 0, relayItems: result.relayItems.length, relayContentWasEmpty: result.relayContentWasEmpty, requiresConfirmation: result.requiresConfirmation, snapshotDiffInfo: result.snapshotDiffInfo, categories: result.categories });
          return {
            diff: { added: result.diff.added, removed: result.diff.removed, moved: result.diff.moved },
            relayItems: result.relayItems,
            relayContentWasEmpty: result.relayContentWasEmpty,
            requiresConfirmation: result.requiresConfirmation,
            relayTimestamp: result.relayTimestamp,
            snapshotDiffInfo: result.snapshotDiffInfo,
            categoryAssignments: result.categoryAssignments,
            categories: result.categories,
            ...(result.deletedCoordinates ? { deletedCoordinates: result.deletedCoordinates } : {})
          };
        }

        case 'mutes': {
          const result = await this.muteAdapter.syncFromRelays();
          diagLog('lists', 'fetchAndCompare(mutes): raw adapter result', { diffAdded: result.diff.added.length, diffRemoved: result.diff.removed.length, relayItems: result.relayItems.length, relayContentWasEmpty: result.relayContentWasEmpty, requiresConfirmation: result.requiresConfirmation });
          return {
            diff: { added: result.diff.added, removed: result.diff.removed },
            relayItems: result.relayItems,
            relayContentWasEmpty: result.relayContentWasEmpty,
            requiresConfirmation: result.requiresConfirmation,
            relayTimestamp: result.relayTimestamp,
            categoryAssignments: undefined,
            categories: undefined
          };
        }

        case 'tribes': {
          const result = await this.tribeAdapter.syncFromRelays();
          diagLog('lists', 'fetchAndCompare(tribes): raw adapter result', { diffAdded: result.diff.added.length, diffRemoved: result.diff.removed.length, diffMoved: result.diff.moved?.length || 0, relayItems: result.relayItems.length, relayContentWasEmpty: result.relayContentWasEmpty, requiresConfirmation: result.requiresConfirmation, categories: result.categories });
          return {
            diff: { added: result.diff.added, removed: result.diff.removed, moved: result.diff.moved },
            relayItems: result.relayItems,
            relayContentWasEmpty: result.relayContentWasEmpty,
            requiresConfirmation: result.requiresConfirmation,
            relayTimestamp: result.relayTimestamp,
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
  /**
   * Apply overwrite strategy (replace browser with relay)
   */
  private applyOverwrite(listType: ListType, relayItems: unknown[], relayContentWasEmpty: boolean): void {
    diagLog('lists', `applyOverwrite(${listType})`, { relayItemsCount: relayItems.length, relayContentWasEmpty });
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
    diagLog('lists', `applyFolderAssignments(${listType})`, { relayItemsCount: result.relayItems.length, categories: result.categories, categoryAssignmentsSize: result.categoryAssignments?.size || 0 });
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
   * Get the newest timestamp from relay items (max addedAt) or from SyncResult.relayTimestamp
   */
  private getRelayTimestamp(result: SyncResult): number {
    // Use explicit relayTimestamp if available (set by adapters from event.created_at)
    if (result.relayTimestamp && result.relayTimestamp > 0) return result.relayTimestamp;
    // Fallback: extract from items
    let max = 0;
    for (const item of result.relayItems) {
      const obj = item as Record<string, unknown>;
      const addedAt = typeof obj.addedAt === 'number' ? obj.addedAt : 0;
      if (addedAt > max) max = addedAt;
    }
    return max;
  }
}

// Internal type for sync results
interface SyncResult {
  diff: { added: unknown[]; removed: unknown[]; moved?: unknown[] };
  relayItems: unknown[];
  relayContentWasEmpty: boolean;
  relayTimestamp?: number;
  requiresConfirmation: boolean;
  snapshotDiffInfo?: { isOrderOnly: boolean; hasFolderSetDiff: boolean; details: string[] };
  categoryAssignments: Map<string, string> | undefined;
  categories: string[] | undefined;
  /** Bookmarks-only: kind:5 deletion coordinates from this fetch, used by the
   *  applyOverwrite sanity-check to detect incomplete fetches. */
  deletedCoordinates?: Map<string, number>;
}
