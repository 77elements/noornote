/**
 * BookmarkReadStateService — cross-instance sync of bookmark read-markers
 * via NIP-78 (kind:30078, NIP-44 self-encrypted, d-tag
 * "noornote-bookmarks-read"). Extends the established
 * Nip78EncryptedListService pattern (petnames, soft mutes) — no contact
 * with the list-sync machinery (AutoSyncService / overwrite paths).
 *
 * Gated by two flags: the Bookmarks addon being enabled AND the
 * "Gelesen-Sync über Relays" toggle in the addon settings (default OFF —
 * see docs/todos/unread-bookmarks.md).
 *
 * Cadence: sync on start + interval per frequency setting + debounced
 * publish after local writes. Merge: union, newest readAt per id wins,
 * pruned to locally existing bookmarks (bookmarkReadMerge.ts).
 */

import { Nip78EncryptedListService } from './Nip78EncryptedListService';
import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { diagLog } from './DiagnosticLogger';
import { SystemLogger } from './SystemLogger';
import { TypedEventBus } from '../core/TypedEventBus';
import {
  mergeBookmarkReadMaps,
  type BookmarkReadMap,
} from '../lists/bookmarkReadMerge';

export type ReadSyncFrequency =
  | 'rare'
  | 'moderate'
  | 'frequent'
  | 'more-frequent'
  | 'realtime';

/** Interval in ms per frequency level (mirrors the marketplace levels). */
export const READ_SYNC_INTERVALS: Record<ReadSyncFrequency, number> = {
  rare: 60 * 60 * 1000,
  moderate: 30 * 60 * 1000,
  frequent: 15 * 60 * 1000,
  'more-frequent': 5 * 60 * 1000,
  realtime: 60 * 1000,
};

const PUBLISH_DEBOUNCE_MS = 2000;

export class BookmarkReadStateService extends Nip78EncryptedListService {
  private static instance: BookmarkReadStateService | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private systemLogger: SystemLogger;

  protected get dTag(): string {
    return 'noornote-bookmarks-read';
  }

  protected get logTag(): string {
    return 'BookmarkReadSvc';
  }

  protected override get diagTag(): string {
    return 'BookmarkReadStateService';
  }

  private constructor() {
    super();
    this.systemLogger = SystemLogger.getInstance();
    // Account switch: re-sync immediately for the freshly active account.
    TypedEventBus.getInstance().on('user:login', () => {
      if (this.running) void this.runSync();
    });
  }

  public static getInstance(): BookmarkReadStateService {
    if (!BookmarkReadStateService.instance) {
      BookmarkReadStateService.instance = new BookmarkReadStateService();
    }
    return BookmarkReadStateService.instance;
  }

  /** Local mirror accessor — the fast synchronous source for UI counts. */
  public getLocalMap(): BookmarkReadMap {
    return PerAccountLocalStorage.getInstance().get<BookmarkReadMap>(
      StorageKeys.BOOKMARKS_READ,
      {}
    );
  }

  public writeLocalMap(map: BookmarkReadMap): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.BOOKMARKS_READ, map);
    TypedEventBus.getInstance().emit('bookmark:read', {});
  }

  /**
   * Fetch the remote map WITHOUT merging — used by the domain layer to run
   * its own merge against the local mirror + existing bookmark ids.
   */
  public async fetchRemoteMap(): Promise<BookmarkReadMap | null> {
    if (!(await this.isSyncEnabled())) return null;
    const map = await this.fetchEncryptedMap();
    if (!map) return null;
    return map as BookmarkReadMap;
  }

  /** Debounced publish of the merged read map (relay = sync + backup). */
  public schedulePublish(map: BookmarkReadMap): void {
    void this.assertSyncEnabled().then(ok => {
      if (!ok) return;
      if (this.publishTimer) clearTimeout(this.publishTimer);
      this.publishTimer = setTimeout(() => {
        this.publishTimer = null;
        void this.publishEncryptedMap(
          map,
          'Failed to sync bookmark read state'
        );
      }, PUBLISH_DEBOUNCE_MS);
    });
  }

  /**
   * Start startup-sync + interval sync. Idempotent; stopped via stop()
   * (addon/sync toggle off, addon disabled).
   */
  public async start(): Promise<void> {
    if (this.running) return;
    if (!(await this.isSyncEnabled())) return;
    this.running = true;
    await this.runSync();
    const frequency = this.getFrequency();
    const interval =
      READ_SYNC_INTERVALS[frequency] ?? READ_SYNC_INTERVALS.moderate;
    this.timer = setInterval(() => void this.runSync(), interval);
    this.systemLogger.info(
      'BookmarkReadSvc',
      `Bookmark read-state sync active — every ${READ_SYNC_INTERVALS[frequency] / 60000} min`
    );
    diagLog('system', 'BookmarkReadStateService started', { frequency });
  }

  /**
   * Reset the read-state everywhere: publish an EMPTY map (overwrites the
   * relay event, so other instances converge to all-unread on their next
   * sync) and clear the local mirror. All bookmarks count as unread again.
   * Also emits bookmark:updated so mounted list views re-render their cards
   * (unread borders reappear immediately).
   */
  public async reset(): Promise<void> {
    PerAccountLocalStorage.getInstance().set(StorageKeys.BOOKMARKS_READ, {});
    await this.publishEncryptedMap({}, 'Failed to reset bookmark read state');
    diagLog('system', 'BookmarkReadStateService reset — all bookmarks unread');
    const bus = TypedEventBus.getInstance();
    bus.emit('bookmark:read', { all: true });
    bus.emit('bookmark:updated');
    this.systemLogger.info(
      'BookmarkReadSvc',
      'Bookmark read-state reset — all bookmarks marked unread'
    );
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
    this.running = false;
  }

  public isRunning(): boolean {
    return this.running;
  }

  /** Fetch + merge remote markers into the local mirror (bookmark:read). */
  public async runSync(): Promise<void> {
    if (!(await this.isSyncEnabled())) return;
    const remote = await this.fetchRemoteMap();
    if (!remote) return;

    // Merge against local mirror + existing bookmark ids (dynamic import —
    // lists/bookmarks is a heavy core module; the service stays lean).
    const { readBrowserBookmarks } = await import('../lists/bookmarks');
    const existingIds = new Set(readBrowserBookmarks().map(b => b.id));
    const local = this.getLocalMap();
    const merged = mergeBookmarkReadMaps(local, remote, existingIds);

    this.writeLocalMap(merged);
    this.systemLogger.info(
      'BookmarkReadSvc',
      `Bookmark read-state synced — ${Object.keys(merged).length} bookmarks checked`
    );
    diagLog('system', 'BookmarkReadStateService synced', {
      count: Object.keys(merged).length,
    });
  }

  private async assertSyncEnabled(): Promise<boolean> {
    return this.isSyncEnabled();
  }

  /**
   * Sync gate: Bookmarks addon enabled AND the read-sync toggle on.
   * Dynamic imports — addon flags are lightweight, but the service must not
   * statically depend on addon modules.
   */
  private async isSyncEnabled(): Promise<boolean> {
    try {
      const { isBookmarksEnabled, isReadSyncEnabled } = await import(
        '../addons/bookmarks/index'
      );
      return isBookmarksEnabled() && isReadSyncEnabled();
    } catch {
      return false;
    }
  }

  private getFrequency(): ReadSyncFrequency {
    const stored = PerAccountLocalStorage.getInstance().get<string>(
      StorageKeys.BOOKMARKS_READ_SYNC_FREQUENCY,
      'moderate'
    );
    return (stored as ReadSyncFrequency) in READ_SYNC_INTERVALS
      ? (stored as ReadSyncFrequency)
      : 'moderate';
  }
}
