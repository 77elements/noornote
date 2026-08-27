/**
 * AnalyticsStore — thin persistence layer on NoorDB.
 *
 * Per-Account DB `noornote-analytics-{npub}` (via NoorDB registry → is
 * automatically closed on account switch/logout). Best-effort like FoafStore/
 * ProfileStore: a failed persist just means a full run next time, the UI never
 * blocks. Schema per docs/todos/analytics-addon.md:
 *   - snapshots: one record per collector (metrics + sinceCursor + fetchedAt)
 *   - runs:      run history {t, metrics} — basis for later trend curves (P6 caps)
 */

import {
  openPerAccountDb,
  type NoorDatabase,
} from '../../services/persistence/NoorDB';
import { diagLog } from '../../services/DiagnosticLogger';
import type { CollectorId, CollectorSnapshot } from './collectors';

interface RunRecord {
  t: number;
  metrics: Partial<Record<CollectorId, Record<string, number>>>;
}

const ANALYTICS_DB_VERSION = 1;

class AnalyticsStore {
  private db: NoorDatabase | null = null;
  private npub: string | null = null;
  private openPromise: Promise<NoorDatabase | null> | null = null;

  /** Open (or re-open after account switch) the per-user DB. null on failure. */
  private async ensureDb(): Promise<NoorDatabase | null> {
    const { AuthService } = await import('../../services/AuthService');
    const npub = AuthService.getInstance().getCurrentUser()?.npub;
    if (!npub) return null;

    if (this.db?.isOpen && this.npub === npub) return this.db;
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    if (this.openPromise && this.npub === npub) return this.openPromise;

    this.npub = npub;
    const openPromise = openPerAccountDb('analytics', {
      version: ANALYTICS_DB_VERSION,
      stores: [
        { name: 'snapshots', keyPath: 'collectorId' },
        { name: 'runs', autoIncrement: true },
      ],
      bestEffort: true,
    }).then(
      db => {
        this.db = db;
        return db as NoorDatabase | null;
      },
      () => null
    );
    this.openPromise = openPromise;
    void openPromise.then(() => {
      if (this.openPromise === openPromise) this.openPromise = null;
    });
    return openPromise;
  }

  /** Persist a collector snapshot (fire-and-forget safe). */
  public async saveSnapshot(snapshot: CollectorSnapshot): Promise<void> {
    const db = await this.ensureDb();
    if (!db) return;
    await db.put('snapshots', snapshot);
  }

  /** Load all persisted snapshots (instant paint on revisit). */
  public async loadSnapshots(): Promise<Map<CollectorId, CollectorSnapshot>> {
    const out = new Map<CollectorId, CollectorSnapshot>();
    const db = await this.ensureDb();
    if (!db) return out;
    const all = await db.getAll<CollectorSnapshot>('snapshots');
    for (const snap of all) {
      if (snap && snap.collectorId) out.set(snap.collectorId, snap);
    }
    return out;
  }

  /** Append a run-history record (basis for trends, capped from P6). */
  public async appendRun(record: RunRecord): Promise<void> {
    const db = await this.ensureDb();
    if (!db) return;
    await db.put('runs', record);
    const count = await db.count('runs');
    if (count > 90) {
      // Hard cap already in P1 — the history must never grow unbounded.
      await db.withStore(
        'runs',
        'readwrite',
        store =>
          new Promise<void>(resolve => {
            const excess = count - 90;
            let deleted = 0;
            const cursorReq = store.openCursor();
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
          })
      );
      diagLog('addons', 'analytics: run history capped to 90', { count });
    }
  }

  /** First-run detection: no snapshots AND no run history yet. */
  public async hasAnyData(): Promise<boolean> {
    const db = await this.ensureDb();
    if (!db) return false;
    const snapshots = await db.count('snapshots');
    if (snapshots > 0) return true;
    const runs = await db.count('runs');
    return runs > 0;
  }

  /** Explicit reset (Settings-Cache-Clear later / tests). */
  public async clear(): Promise<void> {
    const db = await this.ensureDb();
    if (!db) return;
    await db.clear('snapshots');
    await db.clear('runs');
    diagLog('addons', 'analytics: store cleared', {});
  }

  public close(): void {
    this.db?.close();
    this.db = null;
    this.npub = null;
    this.openPromise = null;
  }
}

export const analyticsStore = new AnalyticsStore();
