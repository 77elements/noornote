/**
 * DiagnosticLogger — File-based diagnostic logging
 *
 * Writes structured logs to ~/.noornote/{npub}/logs/ as JSONL files.
 * Replaces console.debug('[DIAG:...]') calls with persistent file logs.
 *
 * - Tauri Desktop: Writes to files (buffered, with rotation)
 * - Android / Web: No-op (no file access)
 *
 * Usage:
 *   import { diagLog } from '../services/DiagnosticLogger';
 *   diagLog('lists', 'syncFromRelays started', { listType: 'bookmarks' });
 *
 * Log files:
 *   ~/.noornote/{npub}/logs/lists.jsonl
 *   ~/.noornote/{npub}/logs/dms.jsonl
 *   ~/.noornote/{npub}/logs/crashes.jsonl
 *   ~/.noornote/{npub}/logs/relays.jsonl
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
let tauriWriteTextFile: typeof import('@tauri-apps/plugin-fs').writeTextFile | null = null;
let tauriExists: typeof import('@tauri-apps/plugin-fs').exists | null = null;
let tauriMkdir: typeof import('@tauri-apps/plugin-fs').mkdir | null = null;

const platform = PlatformService.getInstance();

if (platform.isTauri && !platform.isAndroid) {
  import('@tauri-apps/api/path').then(mod => { tauriHomeDir = mod.homeDir; });
  import('@tauri-apps/plugin-fs').then(mod => {
    tauriOpen = mod.open;
    tauriReadTextFile = mod.readTextFile;
    tauriWriteTextFile = mod.writeTextFile;
    tauriExists = mod.exists;
    tauriMkdir = mod.mkdir;
  });
}

// ===== Constants =====

const MAX_LINES = 5000;
const TRIM_TO = 4000;
const FLUSH_INTERVAL_MS = 2000;
const FLUSH_THRESHOLD = 50;
const ROTATION_CHECK_INTERVAL = 100;

// ===== Service =====

class DiagnosticLogger {
  private static instance: DiagnosticLogger;

  private logsDir: string | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private buffers: Map<DiagArea, string[]> = new Map();
  private writeCounters: Map<DiagArea, number> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private enabled = false;

  private constructor() {
    // Start flush timer
    this.flushTimer = setInterval(() => this.flushAll(), FLUSH_INTERVAL_MS);
  }

  static getInstance(): DiagnosticLogger {
    if (!DiagnosticLogger.instance) {
      DiagnosticLogger.instance = new DiagnosticLogger();
    }
    return DiagnosticLogger.instance;
  }

  /**
   * Initialize log directory. Called once after login.
   * Safe to call multiple times — only initializes once.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._init();
    await this.initPromise;
  }

  private async _init(): Promise<void> {
    if (!platform.isTauri || platform.isAndroid || !tauriHomeDir || !tauriMkdir || !tauriExists) {
      return;
    }

    try {
      const user = AuthService.getInstance().getCurrentUser();
      if (!user?.npub) return;

      const homePath = await tauriHomeDir();
      this.logsDir = `${homePath}/.noornote/${user.npub}/logs`;

      if (!(await tauriExists(this.logsDir))) {
        await tauriMkdir(this.logsDir, { recursive: true });
      }

      this.enabled = true;
      this.initialized = true;
    } catch {
      // Silent failure — logging should never break the app
    }
  }

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

    const entry: DiagLogEntry = {
      ts: new Date().toISOString(),
      area,
      msg,
      data
    };

    const line = JSON.stringify(entry);

    // Buffer the line
    const buffer = this.buffers.get(area) || [];
    buffer.push(line);
    this.buffers.set(area, buffer);

    // Crash: flush ALL areas immediately (crash entry + context from other areas)
    if (area === 'crashes') {
      this.flushAll();
      return;
    }

    // Flush if buffer is full
    if (buffer.length >= FLUSH_THRESHOLD) {
      this.flush(area);
    }
  }

  /**
   * Read all entries from a log file
   */
  async readLog(area: DiagArea): Promise<DiagLogEntry[]> {
    await this.init();
    if (!this.enabled || !this.logsDir || !tauriReadTextFile) return [];

    // Flush pending entries first
    await this.flush(area);

    try {
      const content = await tauriReadTextFile(`${this.logsDir}/${area}.jsonl`);
      return content
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as DiagLogEntry);
    } catch {
      return [];
    }
  }

  /**
   * Read last N entries from a log file
   */
  async tail(area: DiagArea, n: number = 50): Promise<DiagLogEntry[]> {
    const entries = await this.readLog(area);
    return entries.slice(-n);
  }

  /**
   * Clear a log file
   */
  async clearLog(area: DiagArea): Promise<void> {
    await this.init();
    if (!this.enabled || !this.logsDir || !tauriWriteTextFile) return;

    this.buffers.delete(area);
    this.writeCounters.delete(area);

    try {
      await tauriWriteTextFile(`${this.logsDir}/${area}.jsonl`, '');
    } catch {
      // Silent
    }
  }

  /**
   * Get file path for a log area
   */
  getLogPath(area: DiagArea): string | null {
    if (!this.logsDir) return null;
    return `${this.logsDir}/${area}.jsonl`;
  }

  /**
   * Get all log file paths
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
   * Flush buffer for one area to disk using atomic append.
   * Uses open(append) instead of read-modify-write to prevent data loss on crash.
   */
  private async flush(area: DiagArea): Promise<void> {
    const buffer = this.buffers.get(area);
    if (!buffer || buffer.length === 0) return;

    // Take all buffered lines and clear
    const lines = buffer.splice(0, buffer.length);

    await this.init();
    if (!this.enabled || !this.logsDir || !tauriOpen) return;

    const filePath = `${this.logsDir}/${area}.jsonl`;
    const payload = lines.join('\n') + '\n';

    try {
      const file = await tauriOpen(filePath, { append: true, create: true });
      await file.write(new TextEncoder().encode(payload));
      await file.close();

      // Track writes for rotation check
      const count = (this.writeCounters.get(area) || 0) + lines.length;
      this.writeCounters.set(area, count);

      // Periodic rotation check
      if (count >= ROTATION_CHECK_INTERVAL) {
        this.writeCounters.set(area, 0);
        await this.rotateIfNeeded(filePath);
      }
    } catch {
      // Silent — logging must never break the app
    }
  }

  /**
   * Flush all buffered areas
   */
  private async flushAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const area of this.buffers.keys()) {
      promises.push(this.flush(area));
    }
    await Promise.all(promises);
  }

  /**
   * Rotate log file if it exceeds MAX_LINES
   */
  private async rotateIfNeeded(filePath: string): Promise<void> {
    if (!tauriReadTextFile || !tauriWriteTextFile) return;

    try {
      const content = await tauriReadTextFile(filePath);
      const lines = content.split('\n').filter(l => l.trim());

      if (lines.length > MAX_LINES) {
        const trimmed = lines.slice(-TRIM_TO);
        await tauriWriteTextFile(filePath, trimmed.join('\n') + '\n');
      }
    } catch {
      // Silent
    }
  }

  /**
   * Clean up (call on logout)
   */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Synchronous — can't flush async on destroy
    this.buffers.clear();
    this.writeCounters.clear();
    this.logsDir = null;
    this.initialized = false;
    this.enabled = false;
    this.initPromise = null;
  }
}

// ===== Convenience export =====

/**
 * Log a diagnostic entry to file.
 *
 * Drop-in replacement for console.debug('[DIAG:...]', ...).
 * No-op on Web and Android. Fire-and-forget — never throws.
 *
 * @param area - Log file target: 'lists', 'dms', 'crashes', 'relays'
 * @param msg - Short description
 * @param data - Optional structured data (will be JSON-serialized)
 */
export function diagLog(area: DiagArea, msg: string, data?: unknown): void {
  DiagnosticLogger.getInstance().log(area, msg, data);
}

/**
 * Initialize the DiagnosticLogger (call after login)
 */
export async function initDiagnosticLogger(): Promise<void> {
  await DiagnosticLogger.getInstance().init();
}

/**
 * Clean up the DiagnosticLogger (call on logout)
 */
export function destroyDiagnosticLogger(): void {
  DiagnosticLogger.getInstance().destroy();
}

// ===== Console helpers (window.__diagLogs) =====

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__diagLogs = {
    read: async (area: DiagArea) => {
      const entries = await DiagnosticLogger.getInstance().readLog(area);
      console.log(`=== ${area}.jsonl (${entries.length} entries) ===`);
      entries.forEach(e => console.log(`[${e.ts}] ${e.msg}`, e.data || ''));
      return entries;
    },
    tail: async (area: DiagArea, n: number = 50) => {
      const entries = await DiagnosticLogger.getInstance().tail(area, n);
      console.log(`=== ${area}.jsonl (last ${entries.length}) ===`);
      entries.forEach(e => console.log(`[${e.ts}] ${e.msg}`, e.data || ''));
      return entries;
    },
    clear: async (area: DiagArea) => {
      await DiagnosticLogger.getInstance().clearLog(area);
      console.log(`${area}.jsonl cleared`);
    },
    paths: () => DiagnosticLogger.getInstance().getAllPaths(),
    areas: ['lists', 'dms', 'crashes', 'relays']
  };
}
