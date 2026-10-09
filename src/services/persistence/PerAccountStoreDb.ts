/**
 * Shared per-account single-store Dexie handle for lightweight cache stores
 * (FoafStore, ProfileStore).
 *
 * Encapsulates the identical account-switch / in-flight-cache logic both
 * stores previously duplicated: open on first use, re-open when the signed-in
 * account changes, never reject (callers fall back to their non-DB path).
 * DB creation itself goes through NoorDB's schema-declared openDb().
 */

import { AuthService } from '../AuthService';
import { openDb, type NoorDatabase } from './NoorDB';

export class PerAccountStoreDb {
  private db: NoorDatabase | null = null;
  private npub: string | null = null;
  private initPromise: Promise<NoorDatabase | null> | null = null;

  constructor(
    private readonly prefix: string,
    private readonly version: number,
    private readonly store: string
  ) {}

  /** npub the DB is currently open for (used by tests/diagnostics). */
  get currentNpub(): string | null {
    return this.npub;
  }

  /** Open (or re-open for a different account) the per-user DB. Resolves null
   *  on failure (no user, IndexedDB unavailable/blocked). */
  async ensureDb(): Promise<NoorDatabase | null> {
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
    const openPromise = openDb(this.prefix + npub, {
      version: this.version,
      stores: [{ name: this.store }],
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
}
