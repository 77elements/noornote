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
 * - Tauri Desktop only (Web/Android: no-op)
 * - Uses atomic append (open + write, no read-modify-write)
 * - Crash entries flush ALL areas immediately
 */

import { PlatformService } from './PlatformService';
import { AuthService } from './AuthService';

// ===== Types =====

export type DiagArea = 'lists' | 'dms' | 'crashes' | 'relays';

interface DiagLogEntry {
  ts: string;
  area: DiagArea;
  msg: string;
  data?: unknown;
}

// ===== Tauri APIs (lazy import) =====

let tauriOpen: typeof import('@tauri-apps/plugin-fs').open | null = null;
let tauriHomeDir: typeof import('@tauri-apps/api/path').homeDir | null = null;
let tauriReadTextFile: typeof import('@tauri-apps/plugin-fs').readTextFile | null = null;
let tauriExists: typeof import('@tauri-apps/plugin-fs').exists | null = null;
let tauriMkdir: typeof import('@tauri-apps/plugin-fs').mkdir | null = null;
let tauriReadDir: typeof import('@tauri-apps/plugin-fs').readDir | null = null;
let tauriRename: typeof import('@tauri-apps/plugin-fs').rename | null = null;
let tauriRemove: typeof import('@tauri-apps/plugin-fs').remove | null = null;
let tauriReadFile: typeof import('@tauri-apps/plugin-fs').readFile | null = null;
let tauriWriteFile: typeof import('@tauri-apps/plugin-fs').writeFile | null = null;

const platform = PlatformService.getInstance();

if (platform.isTauri) {
  if (!platform.isAndroid) {
    import('@tauri-apps/api/path').then(mod => { tauriHomeDir = mod.homeDir; });
  }
  import('@tauri-apps/plugin-fs').then(mod => {
    tauriOpen = mod.open;
    tauriReadTextFile = mod.readTextFile;
    tauriExists = mod.exists;
    tauriMkdir = mod.mkdir;
    tauriReadDir = mod.readDir;
    tauriRename = mod.rename;
    tauriRemove = mod.remove;
    tauriReadFile = mod.readFile;
    tauriWriteFile = mod.writeFile;
  });
}

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

// ===== Service =====

class DiagnosticLogger {
  private static instance: DiagnosticLogger;

  private logsDir: string | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private buffers: Map<DiagArea, string[]> = new Map();
  private currentDate: string = todayDate();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;
  private enabled = false;

  private constructor() {
    this.flushTimer = setInterval(() => this.flushAll(), FLUSH_INTERVAL_MS);
  }

  static getInstance(): DiagnosticLogger {
    if (!DiagnosticLogger.instance) {
      DiagnosticLogger.instance = new DiagnosticLogger();
    }
    return DiagnosticLogger.instance;
  }

  // ===== Initialization =====

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    await this.initPromise;
  }

  private async _init(): Promise<void> {
    if (!platform.isTauri || !tauriMkdir || !tauriExists) {
      return;
    }

    try {
      const user = AuthService.getInstance().getCurrentUser();
      if (!user?.npub) return;

      // Desktop: ~/.noornote/{npub}/logs/
      // Android: {appDataDir}/logs/ (no npub nesting — single user on mobile)
      let basePath: string;
      if (platform.isAndroid) {
        const { appDataDir } = await import('@tauri-apps/api/path');
        basePath = await appDataDir();
        this.logsDir = `${basePath}logs`;
      } else {
        if (!tauriHomeDir) return;
        const homePath = await tauriHomeDir();
        this.logsDir = `${homePath}/.noornote/${user.npub}/logs`;
      }

      // Ensure directories exist
      for (const sub of ['', '/week', '/archive']) {
        const dir = `${this.logsDir}${sub}`;
        if (!(await tauriExists(dir))) {
          await tauriMkdir(dir, { recursive: true });
        }
      }

      this.enabled = true;
      this.initialized = true;

      // Run rotation on startup, then hourly
      this.rotate();
      this.rotationTimer = setInterval(() => this.rotate(), ROTATION_INTERVAL_MS);

      // Migrate legacy files (one-time: lists.jsonl → lists-{date}.jsonl)
      this.migrateLegacyFiles();
    } catch {
      // Silent failure — logging should never break the app
    }
  }

  // ===== Write path =====

  /**
   * Log a diagnostic entry. Fire-and-forget — never throws, never blocks.
   */
  log(area: DiagArea, msg: string, data?: unknown): void {
    // Phase 2: Dual output — console + file (remove console in Phase 3)
    if (data !== undefined) {
      console.debug(`[DIAG:${area}] ${msg}`, data);
    } else {
      console.debug(`[DIAG:${area}] ${msg}`);
    }

    if (!this.enabled && this.initialized) return;

    // Check for date rollover
    const now = todayDate();
    if (now !== this.currentDate) {
      // Flush old day's buffers, then update date
      this.flushAll();
      this.currentDate = now;
      // Trigger rotation for the new day
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

    const lines = buffer.splice(0, buffer.length);

    await this.init();
    if (!this.enabled || !this.logsDir || !tauriOpen) return;

    const filePath = `${this.logsDir}/${this.currentFilename(area)}`;
    const payload = lines.join('\n') + '\n';

    try {
      const file = await tauriOpen(filePath, { append: true, create: true });
      await file.write(new TextEncoder().encode(payload));
      await file.close();
    } catch {
      // Silent — logging must never break the app
    }
  }

  private async flushAll(): Promise<void> {
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
    if (!this.enabled || !this.logsDir || !tauriReadDir || !tauriRename || !tauriRemove) return;

    const today = todayDate();

    try {
      // 1. Root → week/ (files older than today)
      const rootEntries = await tauriReadDir(this.logsDir);
      for (const entry of rootEntries) {
        if (!entry.isFile || !entry.name.endsWith('.jsonl')) continue;
        const fileDate = parseDateFromFilename(entry.name);
        if (!fileDate || fileDate === today) continue;

        // Move to week/
        await tauriRename(
          `${this.logsDir}/${entry.name}`,
          `${this.logsDir}/week/${entry.name}`
        );
      }

      // 2. week/ → archive/ (files older than 7 days, compress)
      const weekDir = `${this.logsDir}/week`;
      const weekEntries = await tauriReadDir(weekDir);
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
          await tauriRemove(`${weekDir}/${entry.name}`);
        }
      }

      // 3. archive/ cleanup (files older than 60 days)
      const archiveDir = `${this.logsDir}/archive`;
      const archiveEntries = await tauriReadDir(archiveDir);
      for (const entry of archiveEntries) {
        if (!entry.isFile) continue;
        const fileDate = parseDateFromFilename(entry.name);
        if (!fileDate) continue;

        const age = daysBetween(fileDate, today);
        if (age > ARCHIVE_RETENTION_DAYS) {
          await tauriRemove(`${archiveDir}/${entry.name}`);
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
    if (!tauriReadFile || !tauriWriteFile) return;

    const rawData = await tauriReadFile(srcPath);
    const inputStream = new Blob([rawData]).stream();
    const compressedStream = inputStream.pipeThrough(new CompressionStream('gzip'));

    // Collect compressed data
    const reader = compressedStream.getReader();
    const chunks: Uint8Array[] = [];
    let done = false;
    while (!done) {
      const result = await reader.read();
      if (result.value) chunks.push(result.value);
      done = result.done;
    }

    // Concat chunks
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const compressed = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      compressed.set(chunk, offset);
      offset += chunk.length;
    }

    await tauriWriteFile(destPath, compressed);
  }

  /**
   * Migrate legacy non-dated files (one-time, e.g. lists.jsonl → lists-{date}.jsonl)
   */
  private async migrateLegacyFiles(): Promise<void> {
    if (!this.logsDir || !tauriReadDir || !tauriRename) return;

    try {
      const entries = await tauriReadDir(this.logsDir);
      const today = todayDate();

      for (const entry of entries) {
        if (!entry.isFile || !entry.name.endsWith('.jsonl')) continue;
        // Legacy file = no date in name (e.g. "lists.jsonl")
        if (parseDateFromFilename(entry.name)) continue;

        const area = entry.name.replace('.jsonl', '') as DiagArea;
        if (!['lists', 'dms', 'crashes', 'relays'].includes(area)) continue;

        // Rename to today's date, then rotation will move it to week/ if needed
        const newName = `${area}-${today}.jsonl`;
        await tauriRename(
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
    await this.init();
    if (!this.enabled || !this.logsDir || !tauriReadTextFile) return [];
    await this.flush(area);

    try {
      const content = await tauriReadTextFile(`${this.logsDir}/${this.currentFilename(area)}`);
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
    await this.init();
    if (!this.enabled || !this.logsDir || !tauriOpen) return;

    this.buffers.delete(area);

    try {
      const file = await tauriOpen(`${this.logsDir}/${this.currentFilename(area)}`, {
        write: true, create: true, truncate: true
      });
      await file.close();
    } catch {
      // Silent
    }
  }

  /**
   * Get file path for today's log
   */
  getLogPath(area: DiagArea): string | null {
    if (!this.logsDir) return null;
    return `${this.logsDir}/${this.currentFilename(area)}`;
  }

  /**
   * Get all log file paths (today)
   */
  getAllPaths(): Record<DiagArea, string | null> {
    const areas: DiagArea[] = ['lists', 'dms', 'crashes', 'relays'];
    const paths: Record<string, string | null> = {};
    for (const area of areas) {
      paths[area] = this.getLogPath(area);
    }
    return paths as Record<DiagArea, string | null>;
  }

  /**
   * Get the logs root directory
   */
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
    this.enabled = false;
    this.initPromise = null;
  }
}

// ===== Convenience exports =====

/**
 * Log a diagnostic entry to file.
 * No-op on Web and Android. Fire-and-forget — never throws.
 */
export function diagLog(area: DiagArea, msg: string, data?: unknown): void {
  DiagnosticLogger.getInstance().log(area, msg, data);
}

/** Initialize the DiagnosticLogger (call after login) */
export async function initDiagnosticLogger(): Promise<void> {
  await DiagnosticLogger.getInstance().init();
}

/** Clean up the DiagnosticLogger (call on logout) */
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
