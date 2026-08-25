/**
 * FollowerSnapshotStorage
 * Dual-layer storage for follower-change detection ("who newly followed me"; new followers only).
 *
 * Lives in core (src/lists, next to MutualChangeStorage) so the NotificationsOrchestrator can
 * restore stored changes on startup without importing the follower-notification addon.
 *
 * Architecture (mirrors MutualChangeStorage):
 * - File (~/.noornote/{npub}/follower-check-data.json) = durable source of truth (desktop only)
 * - PerAccountLocalStorage = runtime cache, works on every platform (per-account isolated)
 *
 * Snapshot model: ACKNOWLEDGED (only advanced on "mark as seen") vs PENDING (last detect()).
 *
 * @purpose Persist the confirmed follower set + detected follower changes
 * @used-by FollowerChangeDetector (addon), NotificationsOrchestrator (restore)
 */

import {
  BaseFileStorage,
  type BaseFileData,
} from '../services/BaseFileStorage';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';

/**
 * Default "count a follow as new for N days" recency window. 7 days fits a roughly-daily user
 * (checks run every 3h, so genuine new follows are caught within hours); a tighter window also
 * suppresses more false positives where an old follower resurfaces via a relay gap with a
 * recently re-published list. Infrequent users can raise it in settings.
 */
export const DEFAULT_RECENCY_DAYS = 7;

export interface FollowerSnapshot {
  timestamp: number;
  followerPubkeys: string[];
}

export interface FollowerChange {
  pubkey: string;
  type: 'new_follower';
  detectedAt: number;
}

export interface FollowerCheckHistoryEntry {
  timestamp: number;
  newFollowerCount: number;
  sweepCount: number;
  durationMs: number;
}

export interface FollowerCheckData extends BaseFileData {
  version: number;
  snapshot: FollowerSnapshot | null;
  lastCheckTimestamp: number | null;
  unseenChanges: boolean;
  changes: FollowerChange[];
  checkHistory: FollowerCheckHistoryEntry[];
  /** True once the baseline is seeded (set immediately by the single seed sweep). */
  warmupComplete: boolean;
}

/** All PerAccountLocalStorage keys managed by this class */
const FOLLOWER_STORAGE_KEYS = [
  StorageKeys.FOLLOWER_SNAPSHOT,
  StorageKeys.FOLLOWER_PENDING_SNAPSHOT,
  StorageKeys.FOLLOWER_LAST_CHECK,
  StorageKeys.FOLLOWER_UNSEEN_CHANGES,
  StorageKeys.FOLLOWER_CHANGES,
  StorageKeys.FOLLOWER_WARMUP_DONE,
  StorageKeys.FOLLOWER_LAST_SWEEP_AT,
] as const;

export class FollowerSnapshotStorage extends BaseFileStorage<FollowerCheckData> {
  private static instance: FollowerSnapshotStorage;
  private perAccountStorage: PerAccountLocalStorage;

  private constructor() {
    super();
    this.perAccountStorage = PerAccountLocalStorage.getInstance();
  }

  public static getInstance(): FollowerSnapshotStorage {
    if (!FollowerSnapshotStorage.instance) {
      FollowerSnapshotStorage.instance = new FollowerSnapshotStorage();
    }
    return FollowerSnapshotStorage.instance;
  }

  protected getFileName(): string {
    return 'follower-check-data.json';
  }

  protected getLoggerName(): string {
    return 'FollowerSnapshotStorage';
  }

  protected getDefaultData(): FollowerCheckData {
    return {
      version: 1,
      lastModified: Math.floor(Date.now() / 1000),
      snapshot: null,
      lastCheckTimestamp: null,
      unseenChanges: false,
      changes: [],
      checkHistory: [],
      warmupComplete: false,
    };
  }

  /** Load durable file into the per-account runtime cache (desktop). Safe no-op on web. */
  public async initFromFile(): Promise<void> {
    try {
      await this.initialize();
      const data = await this.read();

      this.perAccountStorage.set(StorageKeys.FOLLOWER_SNAPSHOT, data.snapshot);
      this.perAccountStorage.set(
        StorageKeys.FOLLOWER_LAST_CHECK,
        data.lastCheckTimestamp
      );
      this.perAccountStorage.set(
        StorageKeys.FOLLOWER_UNSEEN_CHANGES,
        data.unseenChanges
      );
      this.perAccountStorage.set(StorageKeys.FOLLOWER_CHANGES, data.changes);
      this.perAccountStorage.set(
        StorageKeys.FOLLOWER_WARMUP_DONE,
        data.warmupComplete ?? false
      );

      this.systemLogger.info(
        this.getLoggerName(),
        'Initialized from file, per-account storage populated'
      );
    } catch (error) {
      // Web/Android have no file backend — runtime cache is authoritative there.
      this.systemLogger.info(
        this.getLoggerName(),
        `No file backend (using runtime cache): ${String(error)}`
      );
    }
  }

  /** Persist runtime cache to file (desktop). Preserves file-only checkHistory. */
  public async saveToFile(): Promise<void> {
    try {
      const fileData = await this.read();
      const lsData = this.collectFromLocalStorage();

      const mergedData: FollowerCheckData = {
        ...lsData,
        checkHistory: fileData.checkHistory || [],
      };

      await this.write(mergedData);
    } catch (error) {
      this.systemLogger.info(
        this.getLoggerName(),
        `Skipped file save (no backend): ${String(error)}`
      );
    }
  }

  private collectFromLocalStorage(): FollowerCheckData {
    return {
      version: 1,
      lastModified: Math.floor(Date.now() / 1000),
      snapshot: this.perAccountStorage.get<FollowerSnapshot | null>(
        StorageKeys.FOLLOWER_SNAPSHOT,
        null
      ),
      lastCheckTimestamp: this.perAccountStorage.get<number | null>(
        StorageKeys.FOLLOWER_LAST_CHECK,
        null
      ),
      unseenChanges: this.perAccountStorage.get<boolean>(
        StorageKeys.FOLLOWER_UNSEEN_CHANGES,
        false
      ),
      changes: this.perAccountStorage.get<FollowerChange[]>(
        StorageKeys.FOLLOWER_CHANGES,
        []
      ),
      checkHistory: [],
      warmupComplete: this.isWarmupComplete(),
    };
  }

  // ── Warm-up state ──

  public isWarmupComplete(): boolean {
    return this.perAccountStorage.get<boolean>(
      StorageKeys.FOLLOWER_WARMUP_DONE,
      false
    );
  }

  public setWarmupComplete(value: boolean): void {
    this.perAccountStorage.set(StorageKeys.FOLLOWER_WARMUP_DONE, value);
  }

  // ── Recency window (user preference) ──

  /** A follow counts as "new" only if its kind:3 (incl. us) is at most this many days old. */
  public getRecencyDays(): number {
    const v = this.perAccountStorage.get<number>(
      StorageKeys.FOLLOWER_RECENCY_DAYS,
      DEFAULT_RECENCY_DAYS
    );
    return typeof v === 'number' && v > 0 ? v : DEFAULT_RECENCY_DAYS;
  }

  public setRecencyDays(days: number): void {
    this.perAccountStorage.set(StorageKeys.FOLLOWER_RECENCY_DAYS, days);
  }

  // ── Incremental sweep checkpoint ──

  /** Unix seconds floor for the next incremental sweep's `since` (0 if never swept). */
  public getLastSweepAt(): number {
    return this.perAccountStorage.get<number>(
      StorageKeys.FOLLOWER_LAST_SWEEP_AT,
      0
    );
  }

  public setLastSweepAt(unixSeconds: number): void {
    this.perAccountStorage.set(StorageKeys.FOLLOWER_LAST_SWEEP_AT, unixSeconds);
  }

  // ── Snapshot (acknowledged baseline) ──

  public getSnapshot(): FollowerSnapshot | null {
    return this.perAccountStorage.get<FollowerSnapshot | null>(
      StorageKeys.FOLLOWER_SNAPSHOT,
      null
    );
  }

  public saveSnapshot(followerPubkeys: string[]): void {
    const snapshot: FollowerSnapshot = {
      timestamp: Date.now(),
      followerPubkeys,
    };
    this.perAccountStorage.set(StorageKeys.FOLLOWER_SNAPSHOT, snapshot);
    this.perAccountStorage.set(StorageKeys.FOLLOWER_LAST_CHECK, Date.now());
  }

  // ── Pending snapshot (last detect()) ──

  public savePendingSnapshot(followerPubkeys: string[]): void {
    this.perAccountStorage.set(
      StorageKeys.FOLLOWER_PENDING_SNAPSHOT,
      followerPubkeys
    );
    this.perAccountStorage.set(StorageKeys.FOLLOWER_LAST_CHECK, Date.now());
  }

  public getPendingSnapshot(): string[] | null {
    return this.perAccountStorage.get<string[] | null>(
      StorageKeys.FOLLOWER_PENDING_SNAPSHOT,
      null
    );
  }

  public getLastCheckTimestamp(): number | null {
    return this.perAccountStorage.get<number | null>(
      StorageKeys.FOLLOWER_LAST_CHECK,
      null
    );
  }

  // ── Changes ──

  public getChanges(): FollowerChange[] {
    return this.perAccountStorage.get<FollowerChange[]>(
      StorageKeys.FOLLOWER_CHANGES,
      []
    );
  }

  public addChanges(changes: FollowerChange[]): void {
    if (changes.length === 0) return;
    const existing = this.getChanges();
    this.perAccountStorage.set(StorageKeys.FOLLOWER_CHANGES, [
      ...existing,
      ...changes,
    ]);
    this.setUnseenChanges(true);
  }

  public clearChanges(): void {
    this.perAccountStorage.remove(StorageKeys.FOLLOWER_CHANGES);
    this.setUnseenChanges(false);
  }

  /** Drop stored changes for the given pubkeys (e.g. now-muted accounts). Returns true if any were
   *  removed. Clears the unseen flag if nothing remains. */
  public removeChanges(pubkeys: Set<string>): boolean {
    if (pubkeys.size === 0) return false;
    const existing = this.getChanges();
    const kept = existing.filter(c => !pubkeys.has(c.pubkey));
    if (kept.length === existing.length) return false;
    if (kept.length === 0) {
      this.clearChanges();
    } else {
      this.perAccountStorage.set(StorageKeys.FOLLOWER_CHANGES, kept);
    }
    return true;
  }

  public hasUnseenChanges(): boolean {
    return this.perAccountStorage.get<boolean>(
      StorageKeys.FOLLOWER_UNSEEN_CHANGES,
      false
    );
  }

  public setUnseenChanges(value: boolean): void {
    this.perAccountStorage.set(StorageKeys.FOLLOWER_UNSEEN_CHANGES, value);
  }

  // ── History (file only) ──

  public async addHistoryEntry(
    entry: FollowerCheckHistoryEntry
  ): Promise<void> {
    try {
      const data = await this.read();
      data.checkHistory.push(entry);
      if (data.checkHistory.length > 50) {
        data.checkHistory = data.checkHistory.slice(-50);
      }
      await this.write(data);
    } catch {
      // No file backend — history is desktop-only, ignore elsewhere.
    }
  }

  // ── Clear / reset ──

  public clearLocalStorage(): void {
    for (const key of FOLLOWER_STORAGE_KEYS) {
      this.perAccountStorage.remove(key);
    }
  }

  public reset(): void {
    this.clearLocalStorage();
    this.resetInitialization();
  }
}
