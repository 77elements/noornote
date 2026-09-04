/**
 * RelayHealthMonitor Service — PASSIVE relay health scoring.
 *
 * Since the Maturity-Initiative M5.2 this monitor does NOT generate any
 * traffic of its own. The old active probes (dummy kind-1 subscriptions every
 * 10 minutes, batched with backoff) cost data-saver bandwidth and their
 * results were display-only anyway. Health now derives exclusively from real
 * traffic:
 *
 *   - NDK pool connect/disconnect events (socket level)
 *   - directFetch per-relay outcomes: EOSE (+ round-trip ms) = success,
 *     error / timeout = failure (request level)
 *   - publish per-relay ACKs (request level)
 *
 * Everything feeds a sliding 15-minute observation window per relay which
 * powers:
 *   - UI health display (getMetrics / getHealthSummary — unchanged API)
 *   - `isPenalized(url)`: ≥3 failures and 0 successes in the window → the
 *     relay is excluded from best-effort hint publishes (publishWithHints)
 *     and sorted last for fetch quorums
 *   - `sortByScore(urls)`: fastest-first ordering for fetch relay sets
 *
 * NostrTransport calls observeSuccess/observeFailure from its fetch/publish
 * paths; the pool connect/disconnect events flow in via TypedEventBus.
 */

import { TypedEventBus } from '../core/TypedEventBus';

export interface RelayHealthMetrics {
  url: string;
  isConnected: boolean;
  latency: number | null; // ms, null if never connected
  lastConnected: Date | null;
  lastDisconnected: Date | null;
  errorCount: number;
  uptimePercentage: number; // 0-100
}

/** Sliding window for request-level observations. */
const OBSERVATION_WINDOW_MS = 15 * 60 * 1000;
/** Max stored observations per relay (ring cap; window pruning applies too). */
const MAX_OBSERVATIONS = 100;
/** Penalty box: failures in window with zero successes in the same window. */
const PENALTY_MIN_FAILURES = 3;

interface RelayObservation {
  t: number;
  ok: boolean;
  latency?: number;
}

export class RelayHealthMonitor {
  private static instance: RelayHealthMonitor;
  private metrics: Map<string, RelayHealthMetrics> = new Map();
  private observations: Map<string, RelayObservation[]> = new Map();
  private eventBus: TypedEventBus;

  private constructor() {
    this.eventBus = TypedEventBus.getInstance();
    this.setupEventListeners();
  }

  public static getInstance(): RelayHealthMonitor {
    if (!RelayHealthMonitor.instance) {
      RelayHealthMonitor.instance = new RelayHealthMonitor();
    }
    return RelayHealthMonitor.instance;
  }

  /**
   * Setup listeners for relay connection events (socket level — from NDK
   * pool connect/disconnect, forwarded by NostrTransport).
   */
  private setupEventListeners(): void {
    this.eventBus.on(
      'relay:connected',
      (data: { url: string; latency?: number }) => {
        this.observeSuccess(data.url, data.latency);
      }
    );

    this.eventBus.on('relay:error', (data: { url: string }) => {
      this.observeFailure(data.url);
    });
  }

  /**
   * Initialize or get existing metrics for a relay
   */
  private getOrCreateMetrics(url: string): RelayHealthMetrics {
    if (!this.metrics.has(url)) {
      this.metrics.set(url, {
        url,
        isConnected: false,
        latency: null,
        lastConnected: null,
        lastDisconnected: null,
        errorCount: 0,
        uptimePercentage: 0,
      });
    }
    return this.metrics.get(url)!;
  }

  // ── Observation intake (called from NostrTransport) ──────────

  /**
   * Record a success: socket connect, fetch EOSE (with round-trip ms) or a
   * publish ACK. Updates the metrics for display and appends to the sliding
   * window for scoring.
   */
  public observeSuccess(url: string, latency?: number): void {
    const metrics = this.getOrCreateMetrics(url);
    metrics.isConnected = true;
    metrics.lastConnected = new Date();
    metrics.errorCount = 0; // Reset error count on successful connection
    if (latency !== undefined) {
      metrics.latency = latency;
    }

    this.pushObservation(
      url,
      latency !== undefined
        ? { t: Date.now(), ok: true, latency }
        : { t: Date.now(), ok: true }
    );
    this.updateUptimePercentage(url);
    this.eventBus.emit('relay:health:updated', { url, metrics });
  }

  /**
   * Record a failure: fetch error/timeout or a publish without ACK. Socket
   * disconnects also arrive here (via relay:error). Updates metrics and the
   * sliding window.
   */
  public observeFailure(url: string): void {
    const metrics = this.getOrCreateMetrics(url);
    metrics.errorCount++;
    metrics.isConnected = false;
    metrics.lastDisconnected = new Date();

    this.pushObservation(url, { t: Date.now(), ok: false });
    this.updateUptimePercentage(url);
    this.eventBus.emit('relay:health:updated', { url, metrics });
  }

  /** Uptime display value: 100% connected, −10%/hour offline. */
  private updateUptimePercentage(url: string): void {
    const metrics = this.metrics.get(url);
    if (!metrics) return;

    if (metrics.isConnected) {
      metrics.uptimePercentage = 100;
    } else if (metrics.lastDisconnected) {
      const hoursOffline =
        (Date.now() - metrics.lastDisconnected.getTime()) / (1000 * 60 * 60);
      metrics.uptimePercentage = Math.max(0, 100 - hoursOffline * 10);
    }
  }

  private pushObservation(url: string, observation: RelayObservation): void {
    let list = this.observations.get(url);
    if (!list) {
      list = [];
      this.observations.set(url, list);
    }
    list.push(observation);
    if (list.length > MAX_OBSERVATIONS) {
      list.splice(0, list.length - MAX_OBSERVATIONS);
    }
    // Window pruning (keeps the success/fail counts meaningful)
    const cutoff = Date.now() - OBSERVATION_WINDOW_MS;
    while (list.length > 0 && list[0]!.t < cutoff) {
      list.shift();
    }
  }

  // ── Scoring ──────────────────────────────────────────────────

  /** Successes inside the sliding window. */
  private windowSuccesses(url: string): number {
    const cutoff = Date.now() - OBSERVATION_WINDOW_MS;
    return (this.observations.get(url) ?? []).filter(o => o.ok && o.t >= cutoff)
      .length;
  }

  /** Failures inside the sliding window. */
  private windowFailures(url: string): number {
    const cutoff = Date.now() - OBSERVATION_WINDOW_MS;
    return (this.observations.get(url) ?? []).filter(
      o => !o.ok && o.t >= cutoff
    ).length;
  }

  /** Average latency of successful observations in the window (or null). */
  private windowAvgLatency(url: string): number | null {
    const cutoff = Date.now() - OBSERVATION_WINDOW_MS;
    const latencies = (this.observations.get(url) ?? [])
      .filter(o => o.ok && o.t >= cutoff && o.latency !== undefined)
      .map(o => o.latency!);
    if (latencies.length === 0) return null;
    return latencies.reduce((a, b) => a + b, 0) / latencies.length;
  }

  /**
   * Penalty box: the relay accumulated PENALTY_MIN_FAILURES+ failures while
   * delivering ZERO successes within the window. Such relays are excluded
   * from best-effort hint publishes and sorted last for fetches — until a
   * single success clears them.
   */
  public isPenalized(url: string): boolean {
    return (
      this.windowFailures(url) >= PENALTY_MIN_FAILURES &&
      this.windowSuccesses(url) === 0
    );
  }

  /**
   * Order a relay set for fetching: penalized relays last, then known relays
   * by average latency (fastest first), unknown relays in between (original
   * relative order preserved within each group — stable sort).
   */
  public sortByScore(urls: string[]): string[] {
    const rank = (url: string): number => {
      if (this.isPenalized(url)) return 2;
      const avg = this.windowAvgLatency(url);
      return avg === null ? 1 : 0;
    };
    return urls
      .map((url, i) => ({
        url,
        i,
        rank: rank(url),
        latency: this.windowAvgLatency(url),
      }))
      .sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        if (a.rank === 0 && a.latency !== null && b.latency !== null) {
          return a.latency - b.latency;
        }
        return a.i - b.i;
      })
      .map(e => e.url);
  }

  // ── Display API (unchanged surface) ──────────────────────────

  /**
   * Manually record latency measurement
   */
  public recordLatency(url: string, latency: number): void {
    this.observeSuccess(url, latency);
  }

  /**
   * Get health metrics for a specific relay
   */
  public getMetrics(url: string): RelayHealthMetrics | null {
    return this.metrics.get(url) || null;
  }

  /**
   * Get health metrics for all relays
   */
  public getAllMetrics(): RelayHealthMetrics[] {
    return Array.from(this.metrics.values());
  }

  /**
   * Get health summary (for UI display)
   * Uses configured relays as source of truth, not just metrics
   */
  public async getHealthSummary(): Promise<{
    healthy: number;
    total: number;
    warnings: string[];
  }> {
    // Get all configured relays from RelayConfig
    const { RelayConfig } = await import('./RelayConfig');
    const relayConfig = RelayConfig.getInstance();
    const configuredRelays = relayConfig.getAllRelays();

    const total = configuredRelays.length;
    let healthy = 0;
    const warnings: string[] = [];

    // Check each configured relay's health status
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;

    configuredRelays.forEach(relay => {
      const metrics = this.getMetrics(relay.url);

      if (metrics?.isConnected) {
        healthy++;
      } else if (metrics?.lastDisconnected) {
        // Relay has metrics but is disconnected
        const offlineTime = metrics.lastDisconnected.getTime();
        if (offlineTime < threeHoursAgo) {
          const hoursOffline = Math.floor(
            (Date.now() - offlineTime) / (1000 * 60 * 60)
          );
          warnings.push(
            `${relay.url} unreachable for ${hoursOffline}h - consider replacing`
          );
        }
      }
      // If no metrics exist yet, relay is counted as unhealthy (not connected yet)
    });

    return { healthy, total, warnings };
  }

  /**
   * Clear metrics for a specific relay (when removed)
   */
  public clearMetrics(url: string): void {
    this.metrics.delete(url);
    this.observations.delete(url);
  }

  /**
   * Reset all metrics
   */
  public reset(): void {
    this.metrics.clear();
    this.observations.clear();
  }
}
