/**
 * ProfileStore — IndexedDB persistence for UserProfileService's LRU cache.
 *
 * The profile LRU is memory-only, so every cold start (reload, app restart)
 * started with an EMPTY cache: npub-flicker all over the UI, re-fetch of every
 * kind:0, slow discovery. This store mirrors display-bearing profiles into a
 * per-account IndexedDB (`noornote-profiles-{npub}` — same per-user isolation
 * pattern as DMStore / DiagWebStore / FoafStore) and lets
 * UserProfileService.warmFromStore() refill the LRU at login.
 *
 * Rules (enforced by the CALLER, not the store):
 *   • Only profiles carrying display data (name/display_name/username/picture)
 *     are persisted — never name-less placeholders (the "@npub…" poison bug).
 *   • TTL: entries older than PROFILE_TTL_MS are skipped on load (kind:0
 *     changes rarely; 7 days is plenty).
 *   • Per-account DB naming makes cross-account leakage impossible; an
 *     account switch therefore must NOT wipe the store — the DB belongs to
 *     whichever account is current. wipePersisted() exists for the explicit
 *     "clear cache" action in Settings.
 *
 * Never throws — persistence is best-effort (NoorDB bestEffort-Flag); on any
 * failure the caller simply fetches from relays like before.
 */

import { AuthService } from './AuthService';
import type { UserProfile } from './UserProfileService';
import { diagLog } from './DiagnosticLogger';
import { openDb, type NoorDatabase } from './persistence/NoorDB';

const DB_NAME_PREFIX = 'noornote-profiles-';
const DB_VERSION = 1;
const STORE = 'profiles';

/** kind:0 metadata changes rarely — a week-old cached profile is fine to restore. */
export const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PersistedProfile {
  profile: UserProfile;
  savedAt: number;
}

class ProfileStore {
  private db: NoorDatabase | null = null;
  private npub: string | null = null;
  private initPromise: Promise<NoorDatabase | null> | null = null;

  /** True when a DB is open for the given npub (used by tests/diagnostics). */
  get currentNpub(): string | null {
    return this.npub;
  }

  /** Open (or re-open for a different account) the per-user DB. Resolves null
   *  on failure (no user, IndexedDB unavailable/blocked) — callers fall back
   *  to the relay fetch path. */
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

  /** Persist a batch of profiles in one transaction. Fire-and-forget safe. */
  public async saveMany(entries: Map<string, UserProfile>): Promise<void> {
    if (entries.size === 0) return;
    try {
      const db = await this.ensureDb();
      if (!db) return;
      const savedAt = Date.now();
      await db.withStore(STORE, 'readwrite', store => {
        for (const [pubkey, profile] of entries) {
          void store.put(
            { profile, savedAt } satisfies PersistedProfile,
            pubkey
          );
        }
      });
    } catch {
      // best-effort — a failed persist just means a relay fetch next cold start
    }
  }

  /** Load all non-expired entries. Resolves empty on any failure. */
  public async loadAll(): Promise<Map<string, UserProfile>> {
    const out = new Map<string, UserProfile>();
    try {
      const db = await this.ensureDb();
      if (!db) return out;
      const entries = await db.withStore(
        STORE,
        'readonly',
        store =>
          new Promise<Map<string, PersistedProfile>>(resolve => {
            const acc = new Map<string, PersistedProfile>();
            const req = store.openCursor();
            req.onsuccess = () => {
              const cursor = req.result;
              if (cursor) {
                acc.set(String(cursor.key), cursor.value as PersistedProfile);
                cursor.continue();
              } else {
                resolve(acc);
              }
            };
            req.onerror = () => resolve(acc);
          })
      );

      const now = Date.now();
      let expired = 0;
      for (const [pubkey, entry] of entries) {
        if (now - entry.savedAt > PROFILE_TTL_MS) {
          expired++;
          continue;
        }
        out.set(pubkey, entry.profile);
      }
      if (entries.size > 0) {
        diagLog('system', 'ProfileStore: loaded persisted profiles', {
          total: entries.size,
          fresh: out.size,
          expired,
        });
      }
      return out;
    } catch {
      return out;
    }
  }

  /** Drop one persisted entry (profile invalidated after an edit). */
  public async delete(pubkey: string): Promise<void> {
    try {
      const db = await this.ensureDb();
      if (!db) return;
      await db.delete(STORE, pubkey);
    } catch {
      // ignore
    }
  }

  /** Explicit wipe for the Settings "clear cache" action. NOT for account
   *  switches — per-account DB naming already isolates accounts, and clearing
   *  on switch would destroy the newly-current account's warm cache. */
  public async wipePersisted(): Promise<void> {
    try {
      const db = await this.ensureDb();
      if (!db) return;
      await db.clear(STORE);
      diagLog('system', 'ProfileStore: persisted profiles wiped', {});
    } catch {
      // ignore
    }
  }
}

export const profileStore = new ProfileStore();
