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
 * init() rejects on hard open failure so the caller can record an init error
 * — daher KEIN bestEffort-Flag, die Ops fangen selbst still ab.
 */
import type { DiagArea } from './DiagnosticLogger';
import { openDb, type NoorDatabase } from './persistence/NoorDB';

const DB_NAME_PREFIX = 'noornote-diag-';
const DB_VERSION = 1;
// Every DiagArea gets its own store. Matches the file-per-area layout so
// exports stay structurally identical to Desktop/Android.
const AREAS: DiagArea[] = [
  'lists',
  'dms',
  'crashes',
  'relays',
  'addons',
  'wallet',
  'system',
];
/** Per-area entry cap. ~2000 entries ≈ 1–2 MB per area depending on payload. */
const MAX_ENTRIES_PER_AREA = 2000;

interface DiagRecord {
  /** Raw JSONL line (same shape DiagnosticLogger flushes to files). */
  line: string;
  /** Redundant timestamp for ordering/debugging; the line already carries ts. */
  ts: string;
}

class DiagWebStore {
  private db: NoorDatabase | null = null;
  private npub: string | null = null;
  private initPromise: Promise<void> | null = null;

  isReady(): boolean {
    return this.db?.isOpen === true;
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
    if (this.db?.isOpen && this.npub === npub) return Promise.resolve();
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
    const openPromise = openDb(dbName, {
      version: DB_VERSION,
      // autoIncrement keys give stable insertion order for oldest-eviction.
      stores: AREAS.map(area => ({ name: area, autoIncrement: true })),
    }).then(db => {
      this.db = db;
    });
    this.initPromise = openPromise;
    // In-Flight-Cache nach Abschluss leeren (Retry nach Failed-Open, sauberes
    // Re-Open nach versionchange-Auto-Close).
    void openPromise.then(
      () => {
        if (this.initPromise === openPromise) this.initPromise = null;
      },
      () => {
        if (this.initPromise === openPromise) this.initPromise = null;
      }
    );
    return openPromise;
  }

  /**
   * Append raw JSONL lines to an area store, then prune to the cap.
   * Fire-and-forget: logging must never throw or block the caller.
   */
  append(area: DiagArea, lines: string[]): void {
    const db = this.db;
    if (!db?.isOpen || lines.length === 0) return;
    try {
      void db
        .withStore(area, 'readwrite', store => {
          const now = new Date().toISOString();
          for (const line of lines) {
            void store.add({ line, ts: now } satisfies DiagRecord);
          }
        })
        .then(() => this.prune(area))
        .catch(() => {
          /* silent — a failed diag write must never break the app */
        });
    } catch {
      /* silent */
    }
  }

  /**
   * Drop the oldest entries beyond the per-area cap. Runs after each append.
   * Count und Cursor laufen in EINER Transaction — die Count-Auflösung liegt
   * im Success-Event-Microtask, hält die Transaktion aktiv (idb-Pattern).
   */
  private prune(area: DiagArea): void {
    const db = this.db;
    if (!db?.isOpen) return;
    void db
      .withStore(area, 'readwrite', async store => {
        const count = await new Promise<number>(resolve => {
          const countReq = store.count();
          countReq.onsuccess = () => resolve(countReq.result);
          countReq.onerror = () => resolve(0);
        });
        const excess = count - MAX_ENTRIES_PER_AREA;
        if (excess <= 0) return;
        // Keys are auto-increment → ascending cursor visits oldest first.
        await new Promise<void>(resolve => {
          const cursorReq = store.openCursor();
          let deleted = 0;
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor || deleted >= excess) {
              resolve();
              return;
            }
            void cursor.delete();
            deleted++;
            cursor.continue();
          };
          cursorReq.onerror = () => resolve();
        });
      })
      .catch(() => {
        /* silent */
      });
  }

  /**
   * Read every area as a list of raw JSONL lines (insertion order).
   * Used by DiagLogExportService to build the export ZIP.
   */
  async readAll(): Promise<Partial<Record<DiagArea, string[]>>> {
    const db = this.db;
    if (!db?.isOpen) return {};
    const result: Partial<Record<DiagArea, string[]>> = {};
    await Promise.all(
      AREAS.map(area =>
        this.readArea(area).then(lines => {
          if (lines.length) result[area] = lines;
        })
      )
    );
    return result;
  }

  private async readArea(area: DiagArea): Promise<string[]> {
    try {
      const db = this.db;
      if (!db?.isOpen) return [];
      const records = await db.getAll<DiagRecord>(area);
      return records.map(r => r.line);
    } catch {
      return [];
    }
  }

  /** Close the DB connection (account switch / logout). Keeps data on disk. */
  close(): void {
    this.db?.close();
    this.db = null;
    this.npub = null;
    this.initPromise = null;
  }
}

/** Singleton — one diagnostic DB per active account. */
export const diagWebStore = new DiagWebStore();
