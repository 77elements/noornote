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
 * Never throws — persistence is best-effort (NoorDB bestEffort-Flag); on any
 * failure the caller simply rebuilds from relays like before.
 */

import { AuthService } from './AuthService';
import { diagLog } from './DiagnosticLogger';
import { openDb, type NoorDatabase } from './persistence/NoorDB';

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
  private db: NoorDatabase | null = null;
  private npub: string | null = null;
  private initPromise: Promise<NoorDatabase | null> | null = null;

  /** Open (or re-open for a different account) the per-user DB. Resolves null
   *  on failure (no user, IndexedDB unavailable/blocked) — callers fall back
   *  to the relay build path. */
  private async ensureDb(): Promise<NoorDatabase | null> {
    const npub = AuthService.getInstance().getCurrentUser()?.npub;
    if (!npub) return null;

    if (this.db?.isOpen && this.npub === npub) return this.db;
    if (this.db) {
      // Different account — release the old connection; per-account DB naming
      // already isolates the data itself.
      this.db.close();
      this.db = null;
    }

    if (this.initPromise && this.npub === npub) return this.initPromise;

    this.npub = npub;
    const openPromise = openDb(DB_NAME_PREFIX + npub, {
      version: DB_VERSION,
      stores: [{ name: STORE }],
      bestEffort: true,
    }).then(
      db => {
        this.db = db;
        return db as NoorDatabase | null;
      },
      () => null
    );
    this.initPromise = openPromise;
    // In-Flight-Cache nach Abschluss leeren, damit ein versionchange-Close
    // beim nächsten Zugriff sauber neu öffnet (und ein Failed-Open retried).
    void openPromise.then(() => {
      if (this.initPromise === openPromise) this.initPromise = null;
    });
    return openPromise;
  }

  /** Persist one degree's entry. Fire-and-forget, never rejects. */
  public async save(degree: number, entry: FoafPersistedEntry): Promise<void> {
    try {
      const db = await this.ensureDb();
      if (!db) return;
      await db.put(STORE, entry, degree);
    } catch {
      // best-effort — a failed persist just means a rebuild next cold start
    }
  }

  /** Load one degree's entry, or null when absent/unavailable. */
  public async load(degree: number): Promise<FoafPersistedEntry | null> {
    try {
      const db = await this.ensureDb();
      if (!db) return null;
      return (await db.get<FoafPersistedEntry>(STORE, degree)) ?? null;
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
      await db.clear(STORE);
      diagLog('system', 'FoafStore: persisted FOAF degrees cleared', {});
    } catch {
      // ignore
    }
  }
}

export const foafStore = new FoafStore();
