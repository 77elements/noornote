/**
 * MutualChangeStorage
 * Dual-layer storage for mutual change detection (Phase 2-4)
 *
 * Architecture:
 * - File (~/.noornote/{npub}/mutual-check-data.json) = Source of Truth
 * - PerAccountLocalStorage = Runtime cache for fast access (per-account isolated)
 *
 * @purpose Store mutual snapshots and detected changes
 * @used-by MutualChangeDetector, FollowListSecondaryManager (manual "Check for Changes")
 */

import {
  BaseFileStorage,
  type BaseFileData,
} from '../services/BaseFileStorage';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';

export interface MutualSnapshot {
  timestamp: number;
  mutualPubkeys: string[];
}

export interface MutualChange {
  pubkey: string;
  type: 'unfollow' | 'new_mutual';
  detectedAt: number;
}

export interface CheckHistoryEntry {
  timestamp: number;
  unfollowCount: number;
  newMutualCount: number;
  durationMs: number;
}

export interface MutualCheckData extends BaseFileData {
  version: number;
  snapshot: MutualSnapshot | null;
  lastCheckTimestamp: number | null;
  unseenChanges: boolean;
  changes: MutualChange[];
  checkHistory: CheckHistoryEntry[];
}

/** All PerAccountLocalStorage keys managed by this class */
const MUTUAL_STORAGE_KEYS = [
  StorageKeys.MUTUAL_SNAPSHOT,
  StorageKeys.MUTUAL_PENDING_SNAPSHOT,
  StorageKeys.MUTUAL_LAST_CHECK,
  StorageKeys.MUTUAL_UNSEEN_CHANGES,
  StorageKeys.MUTUAL_CHANGES,
] as const;

export class MutualChangeStorage extends BaseFileStorage<MutualCheckData> {
  private static instance: MutualChangeStorage;
  private perAccountStorage: PerAccountLocalStorage;

  private constructor() {
    super();
    this.perAccountStorage = PerAccountLocalStorage.getInstance();
  }

  public static getInstance(): MutualChangeStorage {
    if (!MutualChangeStorage.instance) {
      MutualChangeStorage.instance = new MutualChangeStorage();
    }
    return MutualChangeStorage.instance;
  }

  protected getFileName(): string {
    return 'mutual-check-data.json';
  }

  protected getLoggerName(): string {
    return 'MutualChangeStorage';
  }

  protected getDefaultData(): MutualCheckData {
    return {
      version: 1,
      lastModified: Math.floor(Date.now() / 1000),
      snapshot: null,
      lastCheckTimestamp: null,
      unseenChanges: false,
      changes: [],
      checkHistory: [],
    };
  }

  /**
   * Initialize from file on app startup
   * Populates PerAccountLocalStorage cache from file
   */
  public async initFromFile(): Promise<void> {
    try {
      await this.initialize();
      const data = await this.read();

      this.perAccountStorage.set(StorageKeys.MUTUAL_SNAPSHOT, data.snapshot);
      this.perAccountStorage.set(
        StorageKeys.MUTUAL_LAST_CHECK,
        data.lastCheckTimestamp
      );
      this.perAccountStorage.set(
        StorageKeys.MUTUAL_UNSEEN_CHANGES,
        data.unseenChanges
      );
      this.perAccountStorage.set(StorageKeys.MUTUAL_CHANGES, data.changes);

      this.systemLogger.info(
        this.getLoggerName(),
        'Initialized from file, per-account storage populated'
      );
    } catch (error) {
      this.systemLogger.error(
        this.getLoggerName(),
        `Failed to init from file: ${error}`
      );
    }
  }

  /**
   * Save current PerAccountLocalStorage state to file
   * Preserves checkHistory from file (not stored in localStorage)
   */
  public async saveToFile(): Promise<void> {
    try {
      const fileData = await this.read();
      const lsData = this.collectFromLocalStorage();

      const mergedData: MutualCheckData = {
        ...lsData,
        checkHistory: fileData.checkHistory || [],
      };

      await this.write(mergedData);

      const prevCount = fileData.snapshot?.mutualPubkeys.length || 0;
      const currCount = lsData.snapshot?.mutualPubkeys.length || 0;
      this.systemLogger.info(
        this.getLoggerName(),
        `Saved to file: ${prevCount} -> ${currCount} mutuals (history: ${mergedData.checkHistory.length} entries)`
      );
    } catch (error) {
      this.systemLogger.error(
        this.getLoggerName(),
        `Failed to save to file: ${error}`
      );
    }
  }

  private collectFromLocalStorage(): MutualCheckData {
    return {
      version: 1,
      lastModified: Math.floor(Date.now() / 1000),
      snapshot: this.perAccountStorage.get<MutualSnapshot | null>(
        StorageKeys.MUTUAL_SNAPSHOT,
        null
      ),
      lastCheckTimestamp: this.perAccountStorage.get<number | null>(
        StorageKeys.MUTUAL_LAST_CHECK,
        null
      ),
      unseenChanges: this.perAccountStorage.get<boolean>(
        StorageKeys.MUTUAL_UNSEEN_CHANGES,
        false
      ),
      changes: this.perAccountStorage.get<MutualChange[]>(
        StorageKeys.MUTUAL_CHANGES,
        []
      ),
      checkHistory: [],
    };
  }

  // ========== Snapshot Methods (PerAccountLocalStorage) ==========

  public getSnapshot(): MutualSnapshot | null {
    return this.perAccountStorage.get<MutualSnapshot | null>(
      StorageKeys.MUTUAL_SNAPSHOT,
      null
    );
  }

  public saveSnapshot(mutualPubkeys: string[]): void {
    const snapshot: MutualSnapshot = {
      timestamp: Date.now(),
      mutualPubkeys,
    };
    this.perAccountStorage.set(StorageKeys.MUTUAL_SNAPSHOT, snapshot);
    this.perAccountStorage.set(StorageKeys.MUTUAL_LAST_CHECK, Date.now());
  }

  public savePendingSnapshot(mutualPubkeys: string[]): void {
    this.perAccountStorage.set(
      StorageKeys.MUTUAL_PENDING_SNAPSHOT,
      mutualPubkeys
    );
  }

  public getPendingSnapshot(): string[] | null {
    return this.perAccountStorage.get<string[] | null>(
      StorageKeys.MUTUAL_PENDING_SNAPSHOT,
      null
    );
  }

  public getLastCheckTimestamp(): number | null {
    return this.perAccountStorage.get<number | null>(
      StorageKeys.MUTUAL_LAST_CHECK,
      null
    );
  }

  // ========== Changes Methods (PerAccountLocalStorage) ==========

  public getChanges(): MutualChange[] {
    return this.perAccountStorage.get<MutualChange[]>(
      StorageKeys.MUTUAL_CHANGES,
      []
    );
  }

  public addChanges(changes: MutualChange[]): void {
    const existing = this.getChanges();
    this.perAccountStorage.set(StorageKeys.MUTUAL_CHANGES, [
      ...existing,
      ...changes,
    ]);

    if (changes.length > 0) {
      this.setUnseenChanges(true);
    }
  }

  public clearChanges(): void {
    this.perAccountStorage.remove(StorageKeys.MUTUAL_CHANGES);
    this.setUnseenChanges(false);
  }

  // ========== Unseen Changes Flag ==========

  public hasUnseenChanges(): boolean {
    return this.perAccountStorage.get<boolean>(
      StorageKeys.MUTUAL_UNSEEN_CHANGES,
      false
    );
  }

  public setUnseenChanges(value: boolean): void {
    this.perAccountStorage.set(StorageKeys.MUTUAL_UNSEEN_CHANGES, value);
  }

  // ========== History Methods (file only) ==========

  public async addHistoryEntry(entry: CheckHistoryEntry): Promise<void> {
    try {
      const data = await this.read();
      data.checkHistory.push(entry);

      if (data.checkHistory.length > 50) {
        data.checkHistory = data.checkHistory.slice(-50);
      }

      await this.write(data);
    } catch (error) {
      this.systemLogger.error(
        this.getLoggerName(),
        `Failed to add history entry: ${error}`
      );
    }
  }

  // ========== Clear Methods ==========

  public clearLocalStorage(): void {
    for (const key of MUTUAL_STORAGE_KEYS) {
      this.perAccountStorage.remove(key);
    }
  }

  public reset(): void {
    this.clearLocalStorage();
    this.resetInitialization();
  }
}

// Debug helper
if (typeof window !== 'undefined') {
  (window as any).__MUTUAL_CHANGE_STORAGE__ = {
    logState: () => {
      const storage = MutualChangeStorage.getInstance();
      console.debug('=== MutualChangeStorage State ===');
      console.debug('Snapshot:', storage.getSnapshot());
      console.debug('Last Check:', storage.getLastCheckTimestamp());
      console.debug('Unseen Changes:', storage.hasUnseenChanges());
      console.debug('Changes:', storage.getChanges());
    },
  };
}
