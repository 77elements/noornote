/**
 * MutualCheckDebugLog
 * Persistent debug logging for mutual change detection
 *
 * Stores detailed logs in ~/.noornote/{npub}/mutual-check-debug.log
 * Useful for debugging edge cases like the "Mike scenario"
 *
 * @purpose Debug-Analyse für Mutual-Check Edge Cases
 * @used-by MutualChangeDetector
 */

import { SystemLogger } from '../components/system/SystemLogger';
import { PlatformService } from '../services/PlatformService';
import { AuthService } from '../services/AuthService';

let tauriHomeDir: typeof import('@tauri-apps/api/path').homeDir | null = null;
let tauriReadTextFile: typeof import('@tauri-apps/plugin-fs').readTextFile | null = null;
let tauriWriteTextFile: typeof import('@tauri-apps/plugin-fs').writeTextFile | null = null;
let tauriExists: typeof import('@tauri-apps/plugin-fs').exists | null = null;
let tauriMkdir: typeof import('@tauri-apps/plugin-fs').mkdir | null = null;

const platform = PlatformService.getInstance();

if (platform.isTauri && !platform.isAndroid) {
  import('@tauri-apps/api/path').then(mod => { tauriHomeDir = mod.homeDir; });
  import('@tauri-apps/plugin-fs').then(mod => {
    tauriReadTextFile = mod.readTextFile;
    tauriWriteTextFile = mod.writeTextFile;
    tauriExists = mod.exists;
    tauriMkdir = mod.mkdir;
  });
}

// Electron filesystem helpers (wrapping electronAPI)
function electronReadTextFile(path: string): Promise<string> {
  return window.electronAPI!.readTextFile(path);
}
function electronWriteTextFile(path: string, content: string): Promise<void> {
  return window.electronAPI!.writeTextFile(path, content);
}
async function electronExists(path: string): Promise<boolean> {
  return window.electronAPI!.fsExists(path);
}
async function electronMkdir(path: string): Promise<void> {
  return window.electronAPI!.fsMkdir(path);
}
async function electronHomeDir(): Promise<string> {
  return window.electronAPI!.getHomeDir();
}

export interface DebugLogEntry {
  timestamp: string;
  checkId: string;
  event: string;
  data: Record<string, unknown>;
}

const MAX_LOG_ENTRIES = 200;
const LOG_FILE_NAME = 'mutual-check-debug.log';

export class MutualCheckDebugLog {
  private static instance: MutualCheckDebugLog;
  private systemLogger: SystemLogger;
  private filePath: string | null = null;
  private initialized: boolean = false;
  private currentCheckId: string | null = null;

  private constructor() {
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): MutualCheckDebugLog {
    if (!MutualCheckDebugLog.instance) {
      MutualCheckDebugLog.instance = new MutualCheckDebugLog();
    }
    return MutualCheckDebugLog.instance;
  }

  private getLocalTime(): string {
    return new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!platform.isDesktop) return;

    try {
      const authService = AuthService.getInstance();
      const user = authService.getCurrentUser();
      if (!user?.npub) return;

      let homePath: string;
      if (platform.isElectron) {
        homePath = await electronHomeDir();
      } else {
        if (!tauriHomeDir || !tauriMkdir || !tauriExists) return;
        homePath = await tauriHomeDir();
      }

      const userDir = `${homePath}/.noornote/${user.npub}`;

      if (platform.isElectron) {
        if (!(await electronExists(userDir))) {
          await electronMkdir(userDir);
        }
      } else {
        if (!(await tauriExists!(userDir))) {
          await tauriMkdir!(userDir, { recursive: true });
        }
      }

      this.filePath = `${userDir}/${LOG_FILE_NAME}`;
      this.initialized = true;
    } catch (error) {
      this.systemLogger.error('MutualCheckDebugLog', `Init failed: ${error}`);
    }
  }

  public startCheck(): string {
    this.currentCheckId = `check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return this.currentCheckId;
  }

  public async log(event: string, data: Record<string, unknown>): Promise<void> {
    await this.initialize();

    if (!this.filePath) return;

    // Verify filesystem APIs are available
    if (!platform.isElectron && (!tauriReadTextFile || !tauriWriteTextFile)) return;

    const entry: DebugLogEntry = {
      timestamp: new Date().toISOString(),
      checkId: this.currentCheckId || 'unknown',
      event,
      data
    };

    try {
      let logs: DebugLogEntry[] = [];
      try {
        const content = platform.isElectron
          ? await electronReadTextFile(this.filePath)
          : await tauriReadTextFile!(this.filePath);
        logs = JSON.parse(content);
      } catch {
        logs = [];
      }

      logs.push(entry);

      if (logs.length > MAX_LOG_ENTRIES) {
        logs = logs.slice(-MAX_LOG_ENTRIES);
      }

      if (platform.isElectron) {
        await electronWriteTextFile(this.filePath, JSON.stringify(logs, null, 2));
      } else {
        await tauriWriteTextFile!(this.filePath, JSON.stringify(logs, null, 2));
      }
    } catch (error) {
      this.systemLogger.error('MutualCheckDebugLog', `Write failed: ${error}`);
    }
  }

  public async logCheckStart(
    snapshotCount: number,
    followsCount: number,
    snapshotPubkeys?: string[],
    snapshotTimestamp?: number
  ): Promise<void> {
    await this.log('CHECK_START', {
      previousSnapshotMutualCount: snapshotCount,
      previousSnapshotTimestamp: snapshotTimestamp ? new Date(snapshotTimestamp).toISOString() : null,
      previousSnapshotPubkeys: snapshotPubkeys || [],
      currentFollowsCount: followsCount,
      localTime: this.getLocalTime()
    });
  }

  public async logRelayFetch(
    followsChecked: number,
    mutualsFound: number,
    nonMutualsFound: number,
    fetchDurationMs: number,
    currentMutualPubkeys: string[]
  ): Promise<void> {
    await this.log('RELAY_FETCH_COMPLETE', {
      followsChecked,
      mutualsFound,
      nonMutualsFound,
      fetchDurationMs,
      currentMutualPubkeys
    });
  }

  public async logComparison(
    previousPubkeys: string[],
    currentPubkeys: string[],
    unfollowPubkeys: string[],
    newMutualPubkeys: string[]
  ): Promise<void> {
    await this.log('COMPARISON_RESULT', {
      previousMutualCount: previousPubkeys.length,
      currentMutualCount: currentPubkeys.length,
      unfollowCount: unfollowPubkeys.length,
      newMutualCount: newMutualPubkeys.length,
      unfollowPubkeys,
      newMutualPubkeys,
      removedFromMutuals: unfollowPubkeys,
      addedToMutuals: newMutualPubkeys
    });
  }

  public async logCheckComplete(
    unfollows: string[],
    newMutuals: string[],
    durationMs: number,
    currentMutualCount: number
  ): Promise<void> {
    await this.log('CHECK_COMPLETE', {
      unfollowPubkeys: unfollows,
      newMutualPubkeys: newMutuals,
      unfollowCount: unfollows.length,
      newMutualCount: newMutuals.length,
      totalChanges: unfollows.length + newMutuals.length,
      durationMs,
      currentMutualCount,
      localTime: this.getLocalTime()
    });
  }

  public async logUnfollowDetected(pubkey: string, wasInSnapshot: boolean): Promise<void> {
    await this.log('UNFOLLOW_DETECTED', {
      pubkey,
      wasInPreviousSnapshot: wasInSnapshot,
      detectionTime: new Date().toISOString(),
      localTime: this.getLocalTime()
    });
  }

  public async logNewMutualDetected(pubkey: string): Promise<void> {
    await this.log('NEW_MUTUAL_DETECTED', {
      pubkey,
      detectionTime: new Date().toISOString(),
      localTime: this.getLocalTime()
    });
  }

  public async logNotificationInjected(
    pubkey: string,
    type: 'mutual_unfollow' | 'mutual_new',
    syntheticEventId: string
  ): Promise<void> {
    await this.log('NOTIFICATION_INJECTED', {
      pubkey,
      notificationType: type,
      syntheticEventId,
      injectionTime: new Date().toISOString(),
      localTime: this.getLocalTime()
    });
  }

  public async logSnapshotUpdate(
    previousCount: number,
    newCount: number,
    addedPubkeys: string[],
    removedPubkeys: string[]
  ): Promise<void> {
    await this.log('SNAPSHOT_UPDATE', {
      previousMutualCount: previousCount,
      newMutualCount: newCount,
      delta: newCount - previousCount,
      addedPubkeys,
      removedPubkeys,
      updateTime: new Date().toISOString()
    });
  }

  public async logMutualStatusCheck(pubkey: string, isMutual: boolean, followsBack: boolean): Promise<void> {
    await this.log('MUTUAL_STATUS_CHECK', { pubkey, isMutual, followsBack });
  }

  public async logError(message: string, details?: Record<string, unknown>): Promise<void> {
    await this.log('ERROR', {
      message,
      errorTime: new Date().toISOString(),
      localTime: this.getLocalTime(),
      ...details
    });
  }

  public async logSchedulerEvent(
    event: 'SCHEDULER_START' | 'SCHEDULER_STOP' | 'CHECK_DUE' | 'CHECK_NOT_DUE',
    details?: Record<string, unknown>
  ): Promise<void> {
    await this.log(event, {
      schedulerTime: new Date().toISOString(),
      localTime: this.getLocalTime(),
      ...details
    });
  }

  public async readLogs(): Promise<DebugLogEntry[]> {
    await this.initialize();
    if (!this.filePath) return [];
    if (!platform.isElectron && !tauriReadTextFile) return [];

    try {
      const content = platform.isElectron
        ? await electronReadTextFile(this.filePath)
        : await tauriReadTextFile!(this.filePath);
      return JSON.parse(content);
    } catch {
      return [];
    }
  }

  public getFilePath(): string | null {
    return this.filePath;
  }

  public async clearLogs(): Promise<void> {
    await this.initialize();
    if (!this.filePath) return;
    if (!platform.isElectron && !tauriWriteTextFile) return;

    try {
      if (platform.isElectron) {
        await electronWriteTextFile(this.filePath, JSON.stringify([], null, 2));
      } else {
        await tauriWriteTextFile!(this.filePath, JSON.stringify([], null, 2));
      }
      this.systemLogger.info('MutualCheckDebugLog', 'Logs cleared');
    } catch (error) {
      this.systemLogger.error('MutualCheckDebugLog', `Clear failed: ${error}`);
    }
  }
}

if (typeof window !== 'undefined') {
  (window as any).__MUTUAL_CHECK_DEBUG_LOG__ = {
    readLogs: async () => {
      const log = MutualCheckDebugLog.getInstance();
      const logs = await log.readLogs();
      console.log('=== Mutual Check Debug Logs ===');
      console.log(`File: ${log.getFilePath()}`);
      console.log(`Entries: ${logs.length}`);

      const byCheckId = new Map<string, DebugLogEntry[]>();
      logs.forEach(entry => {
        const existing = byCheckId.get(entry.checkId) || [];
        existing.push(entry);
        byCheckId.set(entry.checkId, existing);
      });

      byCheckId.forEach((entries, checkId) => {
        console.log(`\n========== ${checkId} ==========`);
        entries.forEach(entry => {
          console.log(`[${entry.timestamp}] ${entry.event}`);
          console.log('   Data:', JSON.stringify(entry.data, null, 2));
        });
      });

      return logs;
    },
    getFilePath: () => MutualCheckDebugLog.getInstance().getFilePath(),
    clearLogs: async () => {
      await MutualCheckDebugLog.getInstance().clearLogs();
      console.log('Logs cleared');
    },
    getLastCheck: async () => {
      const log = MutualCheckDebugLog.getInstance();
      const logs = await log.readLogs();
      if (logs.length === 0) {
        console.log('No logs found');
        return null;
      }

      const lastComplete = [...logs].reverse().find(l => l.event === 'CHECK_COMPLETE');
      if (lastComplete) {
        console.log('=== Last Check ===');
        console.log('CheckID:', lastComplete.checkId);
        console.log('Time:', lastComplete.timestamp);
        console.log('Data:', lastComplete.data);

        const checkLogs = logs.filter(l => l.checkId === lastComplete.checkId);
        console.log('\n=== Full Check Log ===');
        checkLogs.forEach(entry => {
          console.log(`[${entry.event}]`, entry.data);
        });

        return checkLogs;
      }

      return null;
    }
  };
}
