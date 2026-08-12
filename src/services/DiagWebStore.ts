/**
 * DiagWebStore — IndexedDB-backed diagnostic ring buffer for the WEB build.
 *
 * The file-based DiagnosticLogger is a no-op on Web (Desktop/Capacitor only).
 * This store is the web backend: on web, `diagLog()` flushes its in-memory
 * buffer into here instead of a file.
 *
 * Mirrors the Desktop model (`~/.noornote/{npub}/logs/`, one file per area):
 *   - Per-account DB: `noornote-diag-{npub}` (isolates per user, like DMStore).
 *   - One object store per DiagArea, auto-increment keys = insertion order.
 *   - Capped ring (MAX_ENTRIES_PER_AREA): oldest entries pruned after append.
 * No date rotation is needed — the cap IS the retention. At export time the
 * entries (each a raw JSONL line carrying its own ISO `ts`) are grouped by
 * date to synthesize `{area}-{date}.jsonl` filenames identical to Desktop's,
 * so the `diagnose/*.py` tooling consumes web exports unchanged.
 *
 * Never throws (logging must not break the app). All ops are fire-and-forget.
 */
import type { DiagArea } from './DiagnosticLogger';

const DB_NAME_PREFIX = 'noornote-diag-';
const DB_VERSION = 1;
// Every DiagArea gets its own store. Matches the file-per-area layout so
// exports stay structurally identical to Desktop/Android.
const AREAS: DiagArea[] = ['lists', 'dms', 'crashes', 'relays', 'addons', 'wallet', 'system'];
/** Per-area entry cap. ~2000 entries ≈ 1–2 MB per area depending on payload. */
const MAX_ENTRIES_PER_AREA = 2000;

interface DiagRecord {
  /** Raw JSONL line (same shape DiagnosticLogger flushes to files). */
  line: string;
  /** Redundant timestamp for ordering/debugging; the line already carries ts. */
  ts: string;
}

class DiagWebStore {
  private db: IDBDatabase | null = null;
  private npub: string | null = null;
  private initPromise: Promise<void> | null = null;

  isReady(): boolean {
    return this.db !== null;
  }

  getNpub(): string | null {
    return this.npub;
  }

  /**
   * Open (or re-open for a different account) the per-user diagnostic DB.
   * Idempotent for the same npub. Resolves once the DB is usable; rejects on
   * hard open failure so the caller can record an init error.
   */
  init(npub: string): Promise<void> {
    // Already open for this user.
    if (this.db && this.npub === npub) return Promise.resolve();
    // Switching accounts — close the old connection first.
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.npub = npub;

    // Coalesce concurrent init calls for the same npub.
    if (this.initPromise && this.getNpub() === npub) {
      return this.initPromise;
    }

    const dbName = DB_NAME_PREFIX + npub;
    this.initPromise = new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(dbName, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        // Another tab holds an older version; stays pending until it closes.
        // Don't reject — resolve once it eventually opens.
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        for (const area of AREAS) {
          if (!db.objectStoreNames.contains(area)) {
            // autoIncrement keys give stable insertion order for oldest-eviction.
            db.createObjectStore(area, { autoIncrement: true });
          }
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        // If the DB is invalidated (e.g. cleared via DevTools) elsewhere,
        // drop our handle so the next init reopens cleanly.
        this.db.onversionchange = () => {
          this.db?.close();
          this.db = null;
        };
        resolve();
      };
    });

    return this.initPromise;
  }

  /**
   * Append raw JSONL lines to an area store, then prune to the cap.
   * Fire-and-forget: logging must never throw or block the caller.
   */
  append(area: DiagArea, lines: string[]): void {
    const db = this.db;
    if (!db || lines.length === 0) return;
    if (!db.objectStoreNames.contains(area)) return;
    try {
      const tx = db.transaction(area, 'readwrite');
      const store = tx.objectStore(area);
      const now = new Date().toISOString();
      for (const line of lines) {
        const rec: DiagRecord = { line, ts: now };
        store.add(rec);
      }
      tx.oncomplete = () => this.prune(area);
      tx.onerror = () => {
        /* silent — a failed diag write must never break the app */
      };
    } catch {
      /* silent */
    }
  }

  /**
   * Drop the oldest entries beyond the per-area cap. Runs after each append.
   */
  private prune(area: DiagArea): void {
    const db = this.db;
    if (!db || !db.objectStoreNames.contains(area)) return;
    try {
      const tx = db.transaction(area, 'readwrite');
      const store = tx.objectStore(area);
      const countReq = store.count();
      countReq.onsuccess = () => {
        const excess = countReq.result - MAX_ENTRIES_PER_AREA;
        if (excess <= 0) return;
        // Keys are auto-increment → ascending cursor visits oldest first.
        const cursorReq = store.openCursor();
        let deleted = 0;
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || deleted >= excess) return;
          cursor.delete();
          deleted++;
          cursor.continue();
        };
      };
      tx.onerror = () => {
        /* silent */
      };
    } catch {
      /* silent */
    }
  }

  /**
   * Read every area as a list of raw JSONL lines (insertion order).
   * Used by DiagLogExportService to build the export ZIP.
   */
  async readAll(): Promise<Partial<Record<DiagArea, string[]>>> {
    const db = this.db;
    if (!db) return {};
    const result: Partial<Record<DiagArea, string[]>> = {};
    const present = AREAS.filter(a => db.objectStoreNames.contains(a));
    await Promise.all(
      present.map(area =>
        this.readArea(area).then(lines => {
          if (lines.length) result[area] = lines;
        }),
      ),
    );
    return result;
  }

  private readArea(area: DiagArea): Promise<string[]> {
    const db = this.db!;
    return new Promise<string[]>(resolve => {
      try {
        const tx = db.transaction(area, 'readonly');
        const store = tx.objectStore(area);
        const req = store.getAll();
        req.onsuccess = () =>
          resolve((req.result as DiagRecord[]).map(r => r.line));
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  /** Close the DB connection (account switch / logout). Keeps data on disk. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.npub = null;
    this.initPromise = null;
  }
}

/** Singleton — one diagnostic DB per active account. */
export const diagWebStore = new DiagWebStore();
