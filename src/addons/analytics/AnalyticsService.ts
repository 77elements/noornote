/**
 * AnalyticsService — run orchestration for the Analytics addon.
 *
 * View-driven: runs are started ONLY by AnalyticsAddonView (route visit /
 * Refresh), never at login — relay sweeps happen exclusively while the user
 * is looking at the page (relay-friendliness, see docs/todos/analytics-addon.md).
 *
 * A run walks all collectors SEQUENTIALLY; they share ONE SweepCache (three
 * paginated sweeps total per full run). Each snapshot is persisted to the
 * AnalyticsStore immediately and announced via `analytics:section-ready` so
 * the view fills the affected row. Cached snapshots paint instantly on
 * revisit; a run then refreshes them incrementally (since cursors), a
 * Refresh forces a full run (heals deletion drift).
 *
 * Lifecycle: the per-account DB is owned by the NoorDB registry (closed on
 * account switch/logout; ensureDb re-opens transparently). The service itself
 * is app-long-lived; in-flight runs complete even when the view unmounts —
 * their snapshots land in the store and are served on the next visit.
 */

import { TypedEventBus } from '../../core/TypedEventBus';
import { AuthService } from '../../services/AuthService';
import { diagLog } from '../../services/DiagnosticLogger';
import { analyticsStore } from './AnalyticsStore';
import {
  SweepCache,
  COLLECTORS,
  type RunContext,
  type CollectorSnapshot,
} from './collectors';

export class AnalyticsService {
  private static instance: AnalyticsService;

  /** In-memory mirror of persisted snapshots — instant paint source. */
  private snapshots = new Map<string, CollectorSnapshot>();
  private ready = false;
  private firstRun = true;
  private runInFlight: Promise<void> | null = null;
  /** Run-Generation: ein forceFull-Run superseded laufende Runs (stoppen an der nächsten Collector-Grenze). */
  private runGeneration = 0;

  public static getInstance(): AnalyticsService {
    if (!AnalyticsService.instance) {
      AnalyticsService.instance = new AnalyticsService();
    }
    return AnalyticsService.instance;
  }

  private constructor() {}

  /**
   * DB öffnen + persistierte Snapshots in den Speicher laden.
   * Liefert firstRun = true, wenn noch keinerlei Daten existieren (erste
   * Aktivierung) — die View zeigt daraufhin die First-Run-Notiz.
   */
  public async ensureReady(): Promise<{ firstRun: boolean }> {
    if (this.ready) return { firstRun: this.firstRun };

    const [persisted, hasData] = await Promise.all([
      analyticsStore.loadSnapshots(),
      analyticsStore.hasAnyData(),
    ]);
    this.snapshots = persisted;
    this.firstRun = !hasData;
    this.ready = true;
    return { firstRun: this.firstRun };
  }

  /** Cached snapshot für Sofort-Darstellung (null = noch nie ermittelt). */
  public getCachedSnapshot(id: string): CollectorSnapshot | null {
    return this.snapshots.get(id) ?? null;
  }

  public isFirstRun(): boolean {
    return this.firstRun;
  }

  /**
   * Run anstoßen. Normale Aufrufe teilen den laufenden Run (Dedup); ein
   * forceFull-Run (Refresh) SUPERSEDED ihn: die alte Schleife stoppt an der
   * nächsten Collector-Grenze, der neue Volllauf übernimmt. Läuft weiter,
   * auch wenn die View unmountet (Snapshots landen im Store).
   */
  public startRun(opts?: { forceFull?: boolean }): Promise<void> {
    if (this.runInFlight) {
      if (!opts?.forceFull) return this.runInFlight;
      this.runGeneration++;
    }
    const myGeneration = this.runGeneration;
    const run = this.doRun(opts?.forceFull === true, myGeneration).finally(
      () => {
        if (this.runInFlight === run) this.runInFlight = null;
      }
    );
    this.runInFlight = run;
    return run;
  }

  private async doRun(forceFull: boolean, generation: number): Promise<void> {
    const pubkey = AuthService.getInstance().getCurrentUser()?.pubkey;
    if (!pubkey) {
      diagLog('addons', 'analytics: run skipped — no user', {});
      return;
    }

    const firstRun = this.firstRun;
    const fullRun = forceFull || firstRun;
    const t0 = Date.now();
    TypedEventBus.getInstance().emit('analytics:run-started', { firstRun });
    diagLog('addons', 'analytics: run started', { firstRun, fullRun });

    const ctx: RunContext = {
      pubkey,
      fullRun,
      previous: id => this.snapshots.get(id) ?? null,
      sweeps: new SweepCache(),
    };

    const collected: Record<string, Record<string, number>> = {};
    let ok = true;

    for (const collector of COLLECTORS) {
      if (generation !== this.runGeneration) {
        // Superseded durch einen forceFull-Run — keine Events mehr feuern,
        // der neue Run übernimmt die View-Aktualisierung.
        diagLog('addons', 'analytics: run superseded by refresh', {});
        return;
      }
      try {
        const snapshot = await collector.collect(ctx);
        this.snapshots.set(snapshot.collectorId, snapshot);
        void analyticsStore.saveSnapshot(snapshot);
        collected[snapshot.collectorId] = snapshot.metrics;
        TypedEventBus.getInstance().emit('analytics:section-ready', {
          collectorId: snapshot.collectorId,
          metrics: snapshot.metrics,
          fetchedAt: snapshot.fetchedAt,
        });
      } catch (err) {
        ok = false;
        diagLog('addons', 'analytics: collector failed', {
          collectorId: collector.id,
          error: String(err),
        });
      }
    }

    // Nach dem ersten vollständigen Run ist der Initial-Lauf vorbei — auch
    // wenn einzelne Collector fehlschlugen (deren Tiles bleiben im Ladezustand
    // und werden beim nächsten Run nachgefüllt).
    this.firstRun = false;

    if (Object.keys(collected).length > 0) {
      void analyticsStore.appendRun({ t: Date.now(), metrics: collected });
    }

    if (generation !== this.runGeneration) return; // superseded — kein Abschluss-Event
    TypedEventBus.getInstance().emit('analytics:run-finished', {
      firstRun,
      ok,
    });
    diagLog('addons', 'analytics: run finished', {
      firstRun,
      fullRun,
      ok,
      durationMs: Date.now() - t0,
      collectors: Object.keys(collected).length,
    });
  }
}
