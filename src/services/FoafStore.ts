/**
 * FoafStore — IndexedDB persistence for FoafService degree sets.
 *
 * The FOAF graph is expensive to build (~30-70s of kind:3 fetches for degree 2)
 * and only cached in memory, so every cold start (reload, app restart) rebuilt
 * it from scratch. This store mirrors the per-degree cache into a per-account
 * IndexedDB (`noornote-foaf-{npub}` — same per-user isolation pattern as
 * DMStore / DiagWebStore). FoafService applies the SAME freshness rules to a
 * restored entry as to its in-memory cache (follow-count match + 24h TTL), so
 * a stale graph is never served.
 *
 * Never throws — persistence is best-effort; on any failure the caller simply
 * rebuilds from relays like before.
 */

import { AuthService } from './AuthService';
import { diagLog } from './DiagnosticLogger';

const DB_NAME_PREFIX = 'noornote-foaf-';
const DB_VERSION = 1;
const STORE = 'degrees';

export interface FoafPersistedEntry {
  /** Deduplicated pubkeys at this degree, excluding self and lower degrees. */
  pubkeys: string[];
  /** User's follow count at build time — staleness guard on restore. */
  followCountAtBuild: number;
  /** Build timestamp (ms) — 24h TTL guard on restore. */
  builtAt: number;
}

class FoafStore {
  private db: IDBDatabase | null = null;
  private npub: string | null = null;
  private initPromise: Promise<IDBDatabase | null> | null = null;

  /** Open (or re-open for a different account) the per-user DB. Resolves null
   *  on failure (no user, IndexedDB unavailable/blocked) — callers fall back
   *  to the relay build path. */
  private async ensureDb(): Promise<IDBDatabase | null> {
    const npub = AuthService.getInstance().getCurrentUser()?.npub;
    if (!npub) return null;

    if (this.db && this.npub === npub) return this.db;
    if (this.db) {
      this.db.close();
      this.db = null;
      this.npub = null;
    }

    if (this.initPromise && this.npub === npub) return this.initPromise;

    this.npub = npub;
    this.initPromise = new Promise(resolve => {
      const request = indexedDB.open(DB_NAME_PREFIX + npub, DB_VERSION);
      request.onerror = () => resolve(null);
      request.onblocked = () => {
        /* stays pending; resolves when unblocked */
      };
      request.onupgradeneeded = event => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          if (this.db === db) this.db = null;
        };
        this.db = db;
        resolve(db);
      };
    });
    return this.initPromise;
  }

  /** Persist one degree's entry. Fire-and-forget, never rejects. */
  public async save(degree: number, entry: FoafPersistedEntry): Promise<void> {
    try {
      const db = await this.ensureDb();
      if (!db) return;
      await new Promise<void>(resolve => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(entry, degree);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch {
      // best-effort — a failed persist just means a rebuild next cold start
    }
  }

  /** Load one degree's entry, or null when absent/unavailable. */
  public async load(degree: number): Promise<FoafPersistedEntry | null> {
    try {
      const db = await this.ensureDb();
      if (!db) return null;
      return await new Promise(resolve => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(degree);
        req.onsuccess = () =>
          resolve((req.result as FoafPersistedEntry | undefined) ?? null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  /** Drop the currently-open account's persisted degrees (logout / account
   *  switch). Per-account DB naming means other accounts are untouched. */
  public async clear(): Promise<void> {
    try {
      const db = await this.ensureDb();
      if (!db) return;
      await new Promise<void>(resolve => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
      diagLog('system', 'FoafStore: persisted FOAF degrees cleared', {});
    } catch {
      // ignore
    }
  }
}

export const foafStore = new FoafStore();
