/**
 * DiagnosticLogger — File-based diagnostic logging with date-based rotation
 *
 * Writes structured logs to ~/.noornote/{npub}/logs/ as daily JSONL files.
 *
 * Directory structure:
 *   logs/
 *     lists-2026-03-15.jsonl      ← today (active)
 *     crashes-2026-03-15.jsonl
 *     week/
 *       lists-2026-03-14.jsonl    ← last 7 days (uncompressed)
 *       lists-2026-03-13.jsonl
 *     archive/
 *       lists-2026-03-05.jsonl.gz ← 8–60 days ago (gzip compressed)
 *
 * Rotation runs once on init:
 *   1. Root files older than today → move to week/
 *   2. Week files older than 7 days → compress to archive/
 *   3. Archive files older than 60 days → delete
 *
 * - Desktop (Electron) and Capacitor (Android) only (Web: no-op)
 * - Uses atomic append (open + write, no read-modify-write)
 * - Crash entries flush ALL areas immediately
 */

import { PlatformService } from './PlatformService';
import { AuthService } from './AuthService';

// ===== Types =====

export type DiagArea = 'lists' | 'dms' | 'crashes' | 'relays' | 'system';

interface DiagLogEntry {
  ts: string;
  area: DiagArea;
  msg: string;
  data?: unknown;
}

const platform = PlatformService.getInstance();

// ===== Constants =====

const FLUSH_INTERVAL_MS = 2000;
const FLUSH_THRESHOLD = 50;
const WEEK_RETENTION_DAYS = 7;
const ARCHIVE_RETENTION_DAYS = 60;
const ROTATION_INTERVAL_MS = 60 * 60 * 1000; // Check rotation hourly

// ===== Helpers =====

/** Returns YYYY-MM-DD for today (local time) */
function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Parse date from filename like "lists-2026-03-15.jsonl" or "lists-2026-03-15.jsonl.gz" */
function parseDateFromFilename(name: string): string | null {
  const match = name.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

/** Days between two YYYY-MM-DD date strings */
function daysBetween(dateStr: string, referenceStr: string): number {
  const d = new Date(dateStr + 'T00:00:00Z');
  const r = new Date(referenceStr + 'T00:00:00Z');
  return Math.floor((r.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
}

/** Whether this platform supports file-based diagnostic logging */
function supportsFileLogs(): boolean {
  return platform.isDesktop || platform.isCapacitor;
}

// ===== Platform FS wrappers =====
// Capacitor: single lazy-loaded import, all ops use Directory.Data
let _capFsMod: typeof import('@capacitor/filesystem') | null = null;
async function getCapFs() {
  if (!_capFsMod) _capFsMod = await import('@capacitor/filesystem');
  return _capFsMod;
}

async function platformHomeDir(): Promise<string> {
  if (platform.isElectron) return window.electronAPI!.getHomeDir();
  throw new Error('platformHomeDir: not available');
}

async function platformMkdir(dirPath: string): Promise<void> {
  if (platform.isElectron) return window.electronAPI!.fsMkdir(dirPath);
  if (platform.isCapacitor) {
    const { Filesystem, Directory } = await getCapFs();
    await Filesystem.mkdir({ path: dirPath, directory: Directory.Data, recursive: true });
    return;
  }
}

async function platformReadDir(dirPath: string): Promise<Array<{ name: string; isFile: boolean }>> {
  if (platform.isElectron) return window.electronAPI!.readDir(dirPath);
  if (platform.isCapacitor) {
    const { Filesystem, Directory } = await getCapFs();
    const result = await Filesystem.readdir({ path: dirPath, directory: Directory.Data });
    return result.files.map(f => ({ name: f.name, isFile: f.type === 'file' }));
  }
  throw new Error('platformReadDir: not available');
}

async function platformReadTextFile(filePath: string): Promise<string> {
  if (platform.isElectron) return window.electronAPI!.readTextFile(filePath);
  if (platform.isCapacitor) {
    const { Filesystem, Directory, Encoding } = await getCapFs();
    const result = await Filesystem.readFile({ path: filePath, directory: Directory.Data, encoding: Encoding.UTF8 });
    return result.data as string;
  }
  throw new Error('platformReadTextFile: not available');
}

async function platformReadFile(filePath: string): Promise<Uint8Array> {
  if (platform.isElectron) {
    const buf = await window.electronAPI!.readFile(filePath);
    return new Uint8Array(buf);
  }
  if (platform.isCapacitor) {
    const { Filesystem, Directory } = await getCapFs();
    const result = await Filesystem.readFile({ path: filePath, directory: Directory.Data });
    const binary = atob(result.data as string);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  throw new Error('platformReadFile: not available');
}

async function platformWriteFile(filePath: string, data: Uint8Array): Promise<void> {
  if (platform.isElectron) return window.electronAPI!.writeFile(filePath, data);
  if (platform.isCapacitor) {
    const { Filesystem, Directory } = await getCapFs();
    let binary = '';
    for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]!);
    await Filesystem.writeFile({ path: filePath, data: btoa(binary), directory: Directory.Data, recursive: true });
    return;
  }
}

async function platformAppendFile(filePath: string, contents: string): Promise<void> {
  if (platform.isElectron) return window.electronAPI!.fsAppendFile(filePath, contents);
  if (platform.isCapacitor) {
    const { Filesystem, Directory, Encoding } = await getCapFs();
    // appendFile doesn't support recursive, so ensure parent dir exists
    try {
      await Filesystem.appendFile({ path: filePath, data: contents, directory: Directory.Data, encoding: Encoding.UTF8 });
    } catch {
      // File might not exist yet — create with writeFile then append won't fail next time
      await Filesystem.writeFile({ path: filePath, data: contents, directory: Directory.Data, encoding: Encoding.UTF8, recursive: true });
    }
    return;
  }
}

async function platformTruncateFile(filePath: string): Promise<void> {
  if (platform.isElectron) return window.electronAPI!.writeTextFile(filePath, '');
  if (platform.isCapacitor) {
    const { Filesystem, Directory, Encoding } = await getCapFs();
    await Filesystem.writeFile({ path: filePath, data: '', directory: Directory.Data, encoding: Encoding.UTF8, recursive: true });
    return;
  }
}

async function platformRename(oldPath: string, newPath: string): Promise<void> {
  if (platform.isElectron) return window.electronAPI!.fsRename(oldPath, newPath);
  if (platform.isCapacitor) {
    const { Filesystem, Directory } = await getCapFs();
    await Filesystem.rename({ from: oldPath, to: newPath, directory: Directory.Data, toDirectory: Directory.Data });
    return;
  }
}

async function platformRemove(filePath: string): Promise<void> {
  if (platform.isElectron) return window.electronAPI!.fsRemove(filePath);
  if (platform.isCapacitor) {
    const { Filesystem, Directory } = await getCapFs();
    await Filesystem.deleteFile({ path: filePath, directory: Directory.Data });
    return;
  }
}

// ===== Service =====

export class DiagnosticLogger {
  private static instance: DiagnosticLogger;

  private logsDir: string | null = null;
  private initialized = false;
  private initializing = false;
  private initError: string | null = null;
  private flushErrors: number = 0;
  private lastFlushError: string | null = null;
  private flushing = false;

  private buffers: Map<DiagArea, string[]> = new Map();
  private currentDate: string = todayDate();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;

  private constructor() {
    if (supportsFileLogs()) {
      this.flushTimer = setInterval(() => {
        // Auto-init: if not initialized yet, try with current user
        if (!this.initialized && !this.initializing) {
          const user = AuthService.getInstance().getCurrentUser();
          if (user?.npub) this.init(user.npub);
        }
        this.flushAll();
      }, FLUSH_INTERVAL_MS);
    }
  }

  static getInstance(): DiagnosticLogger {
    if (!DiagnosticLogger.instance) {
      DiagnosticLogger.instance = new DiagnosticLogger();
    }
    return DiagnosticLogger.instance;
  }

  /** Diagnostic status for export UI */
  getStatus() {
    const bufferSize = Array.from(this.buffers.values()).reduce((sum, b) => sum + b.length, 0);
    return { initialized: this.initialized, logsDir: this.logsDir, error: this.initError, flushErrors: this.flushErrors, lastFlushError: this.lastFlushError, hasFs: platform.isElectron || platform.isCapacitor, bufferSize };
  }

  // ===== Initialization =====

  async init(npub?: string): Promise<void> {
    if (this.initialized || this.initializing || !supportsFileLogs()) return;

    // Desktop requires npub for path; Android doesn't
    if (!platform.isAndroid && !npub) return;

    this.initializing = true;

    try {
      // Desktop: ~/.noornote/{npub}/logs/
      // Android (Capacitor): logs/ relative to Directory.Data
      if (platform.isCapacitor) {
        this.logsDir = 'logs';
      } else {
        const homePath = await platformHomeDir();
        this.logsDir = `${homePath}/.noornote/${npub}/logs`;
      }

      // Ensure directories exist (mkdir recursive is idempotent)
      for (const sub of ['', '/week', '/archive']) {
        const dir = `${this.logsDir}${sub}`;
        try {
          await platformMkdir(dir);
        } catch {
          // Directory may already exist — that's fine
        }
      }

      this.initialized = true;

      // Flush any buffered entries that arrived before init
      this.flushAll();

      // Run rotation on startup, then hourly
      this.rotate();
      this.rotationTimer = setInterval(() => this.rotate(), ROTATION_INTERVAL_MS);

      // Migrate legacy files (one-time: lists.jsonl → lists-{date}.jsonl)
      this.migrateLegacyFiles();
    } catch (error) {
      this.initError = String(error);
    } finally {
      this.initializing = false;
    }
  }

  // ===== Write path =====

  /**
   * Log a diagnostic entry. Fire-and-forget — never throws, never blocks.
   */
  private logging = false;

  log(area: DiagArea, msg: string, data?: unknown): void {
    if (!supportsFileLogs() || this.logging) return;
    this.logging = true;
    try {
      this._log(area, msg, data);
    } finally {
      this.logging = false;
    }
  }

  private _log(area: DiagArea, msg: string, data?: unknown): void {

    // Check for date rollover
    const now = todayDate();
    if (now !== this.currentDate) {
      this.flushAll();
      this.currentDate = now;
      this.rotate();
    }

    const entry: DiagLogEntry = { ts: new Date().toISOString(), area, msg, data };
    const line = JSON.stringify(entry);

    const buffer = this.buffers.get(area) || [];
    buffer.push(line);
    this.buffers.set(area, buffer);

    // Crash: flush ALL areas immediately (crash entry + context from other areas)
    if (area === 'crashes') {
      this.flushAll();
      return;
    }

    if (buffer.length >= FLUSH_THRESHOLD) {
      this.flush(area);
    }
  }

  /** Current log filename for an area: e.g. "lists-2026-03-15.jsonl" */
  private currentFilename(area: DiagArea): string {
    return `${area}-${this.currentDate}.jsonl`;
  }

  // ===== Flush =====

  private async flush(area: DiagArea): Promise<void> {
    const buffer = this.buffers.get(area);
    if (!buffer || buffer.length === 0) return;
    if (!this.initialized || !this.logsDir) return;

    const lines = buffer.splice(0, buffer.length);
    const filePath = `${this.logsDir}/${this.currentFilename(area)}`;
    const payload = lines.join('\n') + '\n';

    try {
      await platformAppendFile(filePath, payload);
    } catch (error) {
      this.flushErrors++;
      this.lastFlushError = String(error);
    }
  }

  private async flushAll(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      await this._flushAll();
    } finally {
      this.flushing = false;
    }
  }

  private async _flushAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const area of this.buffers.keys()) {
      promises.push(this.flush(area));
    }
    await Promise.all(promises);
  }

  // ===== Rotation =====

  /**
   * Rotate log files:
   * 1. Root files older than today → move to week/
   * 2. Week files older than 7 days → compress to archive/
   * 3. Archive files older than 60 days → delete
   */
  private async rotate(): Promise<void> {
    if (!this.initialized || !this.logsDir) return;

    const today = todayDate();

    try {
      // 1. Root → week/ (files older than today)
      const rootEntries = await platformReadDir(this.logsDir);
      for (const entry of rootEntries) {
        if (!entry.isFile || !entry.name.endsWith('.jsonl')) continue;
        const fileDate = parseDateFromFilename(entry.name);
        if (!fileDate || fileDate === today) continue;

        await platformRename(
          `${this.logsDir}/${entry.name}`,
          `${this.logsDir}/week/${entry.name}`
        );
      }

      // 2. week/ → archive/ (files older than 7 days, compress)
      const weekDir = `${this.logsDir}/week`;
      const weekEntries = await platformReadDir(weekDir);
      for (const entry of weekEntries) {
        if (!entry.isFile || !entry.name.endsWith('.jsonl')) continue;
        const fileDate = parseDateFromFilename(entry.name);
        if (!fileDate) continue;

        const age = daysBetween(fileDate, today);
        if (age > WEEK_RETENTION_DAYS) {
          await this.compressToArchive(
            `${weekDir}/${entry.name}`,
            `${this.logsDir}/archive/${entry.name}.gz`
          );
          await platformRemove(`${weekDir}/${entry.name}`);
        }
      }

      // 3. archive/ cleanup (files older than 60 days)
      const archiveDir = `${this.logsDir}/archive`;
      const archiveEntries = await platformReadDir(archiveDir);
      for (const entry of archiveEntries) {
        if (!entry.isFile) continue;
        const fileDate = parseDateFromFilename(entry.name);
        if (!fileDate) continue;

        const age = daysBetween(fileDate, today);
        if (age > ARCHIVE_RETENTION_DAYS) {
          await platformRemove(`${archiveDir}/${entry.name}`);
        }
      }
    } catch {
      // Silent — rotation failure should never break logging
    }
  }

  /**
   * Compress a JSONL file to gzip using CompressionStream API
   */
  private async compressToArchive(srcPath: string, destPath: string): Promise<void> {
    const rawData = await platformReadFile(srcPath);
    const inputStream = new Blob([rawData as BlobPart]).stream();
    const compressedStream = inputStream.pipeThrough(new CompressionStream('gzip'));

    const reader = compressedStream.getReader();
    const chunks: Uint8Array[] = [];
    let done = false;
    while (!done) {
      const result = await reader.read();
      if (result.value) chunks.push(result.value);
      done = result.done;
    }

    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const compressed = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      compressed.set(chunk, offset);
      offset += chunk.length;
    }

    await platformWriteFile(destPath, compressed);
  }

  /**
   * Migrate legacy non-dated files (one-time, e.g. lists.jsonl → lists-{date}.jsonl)
   */
  private async migrateLegacyFiles(): Promise<void> {
    if (!this.logsDir) return;

    try {
      const entries = await platformReadDir(this.logsDir);
      const today = todayDate();

      for (const entry of entries) {
        if (!entry.isFile || !entry.name.endsWith('.jsonl')) continue;
        // Legacy file = no date in name (e.g. "lists.jsonl")
        if (parseDateFromFilename(entry.name)) continue;

        const area = entry.name.replace('.jsonl', '') as DiagArea;
        if (!['lists', 'dms', 'crashes', 'relays'].includes(area)) continue;

        const newName = `${area}-${today}.jsonl`;
        await platformRename(
          `${this.logsDir}/${entry.name}`,
          `${this.logsDir}/${newName}`
        );
      }
    } catch {
      // Silent
    }
  }

  // ===== Read API =====

  /**
   * Read all entries from today's log file for an area
   */
  async readLog(area: DiagArea): Promise<DiagLogEntry[]> {
    await this.ensureInitForRead();
    if (!this.initialized || !this.logsDir) return [];
    await this.flush(area);

    try {
      const content = await platformReadTextFile(`${this.logsDir}/${this.currentFilename(area)}`);
      return this.parseJsonl(content);
    } catch {
      return [];
    }
  }

  /**
   * Read last N entries from today's log
   */
  async tail(area: DiagArea, n: number = 50): Promise<DiagLogEntry[]> {
    const entries = await this.readLog(area);
    return entries.slice(-n);
  }

  /**
   * Clear today's log file for an area
   */
  async clearLog(area: DiagArea): Promise<void> {
    await this.ensureInitForRead();
    if (!this.initialized || !this.logsDir) return;

    this.buffers.delete(area);

    try {
      await platformTruncateFile(`${this.logsDir}/${this.currentFilename(area)}`);
    } catch {
      // Silent
    }
  }

  /** Try to init from AuthService if not already initialized (for console helpers) */
  private async ensureInitForRead(): Promise<void> {
    if (this.initialized) return;
    const user = AuthService.getInstance().getCurrentUser();
    if (user?.npub) {
      await this.init(user.npub);
    }
  }

  getLogPath(area: DiagArea): string | null {
    if (!this.logsDir) return null;
    return `${this.logsDir}/${this.currentFilename(area)}`;
  }

  getAllPaths(): Record<DiagArea, string | null> {
    const areas: DiagArea[] = ['lists', 'dms', 'crashes', 'relays'];
    const paths: Record<string, string | null> = {};
    for (const area of areas) {
      paths[area] = this.getLogPath(area);
    }
    return paths as Record<DiagArea, string | null>;
  }

  getLogsDir(): string | null {
    return this.logsDir;
  }

  private parseJsonl(content: string): DiagLogEntry[] {
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter((e): e is DiagLogEntry => e !== null);
  }

  // ===== Cleanup =====

  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
    this.buffers.clear();
    this.logsDir = null;
    this.initialized = false;
    this.initializing = false;
  }
}

// ===== Convenience exports =====

export function diagLog(area: DiagArea, msg: string, data?: unknown): void {
  DiagnosticLogger.getInstance().log(area, msg, data);
}

export async function initDiagnosticLogger(npub?: string): Promise<void> {
  await DiagnosticLogger.getInstance().init(npub);
}

export function destroyDiagnosticLogger(): void {
  DiagnosticLogger.getInstance().destroy();
}

// ===== Console helpers (window.__diagLogs) =====

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__diagLogs = {
    read: async (area: DiagArea) => {
      const entries = await DiagnosticLogger.getInstance().readLog(area);
      console.log(`=== ${area} today (${entries.length} entries) ===`);
      entries.forEach(e => console.log(`[${e.ts}] ${e.msg}`, e.data || ''));
      return entries;
    },
    tail: async (area: DiagArea, n: number = 50) => {
      const entries = await DiagnosticLogger.getInstance().tail(area, n);
      console.log(`=== ${area} (last ${entries.length}) ===`);
      entries.forEach(e => console.log(`[${e.ts}] ${e.msg}`, e.data || ''));
      return entries;
    },
    clear: async (area: DiagArea) => {
      await DiagnosticLogger.getInstance().clearLog(area);
      console.log(`${area} today cleared`);
    },
    paths: () => DiagnosticLogger.getInstance().getAllPaths(),
    dir: () => DiagnosticLogger.getInstance().getLogsDir(),
    areas: ['lists', 'dms', 'crashes', 'relays']
  };
}
