/**
 * RelayHealthMonitor Service
 * Monitors relay connection health, latency, and uptime
 *
 * @purpose Track relay health metrics for UI visibility and diagnostics
 * @architecture Singleton service, integrates with NostrTransport
 *
 * Memory optimization:
 * - Batched health checks (max 3 relays per cycle)
 * - Exponential backoff for healthy relays (5min → 15min → 30min)
 * - Unhealthy relays checked every cycle
 */

import { TypedEventBus } from '../core/TypedEventBus';
import { diagLog } from './DiagnosticLogger';
import { isDataSaverEnabled } from './DataSaverService';

export interface RelayHealthMetrics {
  url: string;
  isConnected: boolean;
  latency: number | null; // ms, null if never connected
  lastConnected: Date | null;
  lastDisconnected: Date | null;
  errorCount: number;
  uptimePercentage: number; // 0-100
}

/** How many consecutive healthy checks before backoff increases */
const HEALTHY_STREAK_FOR_BACKOFF = 2;
/** Max relays to ping per health check cycle */
const BATCH_SIZE = 3;

export class RelayHealthMonitor {
  private static instance: RelayHealthMonitor;
  private metrics: Map<string, RelayHealthMetrics> = new Map();
  private eventBus: TypedEventBus;
  private connectionChecks: Map<string, number> = new Map(); // url -> timestamp of last check
  private healthCheckInterval: number | null = null;
  private readonly HEALTH_CHECK_INTERVAL = isDataSaverEnabled()
    ? 30 * 60 * 1000
    : 10 * 60 * 1000;

  /** Track consecutive healthy checks per relay for backoff */
  private healthyStreaks: Map<string, number> = new Map();

  /** Round-robin index for batched checking */
  private batchIndex = 0;

  /** First health check pings all relays (no batching) */
  private isFirstCheck = true;

  private constructor() {
    this.eventBus = TypedEventBus.getInstance();
    this.setupEventListeners();
    this.startPeriodicHealthCheck();
  }

  public static getInstance(): RelayHealthMonitor {
    if (!RelayHealthMonitor.instance) {
      RelayHealthMonitor.instance = new RelayHealthMonitor();
    }
    return RelayHealthMonitor.instance;
  }

  /**
   * Setup listeners for relay connection events
   */
  private setupEventListeners(): void {
    // Listen to relay connection events from NostrTransport
    this.eventBus.on(
      'relay:connected',
      (data: { url: string; latency?: number }) => {
        this.handleRelayConnected(data.url, data.latency);
      }
    );

    this.eventBus.on('relay:error', (data: { url: string }) => {
      this.handleRelayError(data.url);
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

  /**
   * Handle relay connected event
   */
  private handleRelayConnected(url: string, latency?: number): void {
    const metrics = this.getOrCreateMetrics(url);
    metrics.isConnected = true;
    metrics.lastConnected = new Date();
    metrics.errorCount = 0; // Reset error count on successful connection

    if (latency !== undefined) {
      metrics.latency = latency;
    }

    // Track healthy streak for backoff
    this.healthyStreaks.set(url, (this.healthyStreaks.get(url) || 0) + 1);

    this.updateUptimePercentage(url);
    this.eventBus.emit('relay:health:updated', { url, metrics });
  }

  /**
   * Handle relay error event
   */
  private handleRelayError(url: string): void {
    const metrics = this.getOrCreateMetrics(url);
    metrics.errorCount++;
    metrics.isConnected = false;

    // Reset healthy streak
    this.healthyStreaks.set(url, 0);

    diagLog('relays', 'Relay error', { url, errorCount: metrics.errorCount });
    this.eventBus.emit('relay:health:updated', { url, metrics });
  }

  /**
   * Update uptime percentage based on connection history
   * Simple algorithm: 100% if connected, decreases by 10% per hour offline
   */
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

  /**
   * Manually record latency measurement
   */
  public recordLatency(url: string, latency: number): void {
    const metrics = this.getOrCreateMetrics(url);
    metrics.latency = latency;
    this.eventBus.emit('relay:health:updated', { url, metrics });
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
    this.connectionChecks.delete(url);
    this.healthyStreaks.delete(url);
  }

  /**
   * Reset all metrics
   */
  public reset(): void {
    this.metrics.clear();
    this.connectionChecks.clear();
    this.healthyStreaks.clear();
    this.batchIndex = 0;
  }

  /**
   * Start periodic health check (every 10 minutes)
   */
  private startPeriodicHealthCheck(): void {
    // Initial check after 10 seconds
    setTimeout(() => this.performHealthCheck(), 10000);

    // Periodic checks every 10 minutes
    this.healthCheckInterval = window.setInterval(() => {
      this.performHealthCheck();
    }, this.HEALTH_CHECK_INTERVAL);
  }

  /**
   * Check if a relay needs checking this cycle (backoff logic)
   * Healthy relays are checked less frequently:
   * - 0-1 healthy streaks: every cycle
   * - 2-3 healthy streaks: every 2nd cycle (skip 1)
   * - 4+ healthy streaks: every 3rd cycle (skip 2)
   */
  private needsCheck(url: string): boolean {
    const streak = this.healthyStreaks.get(url) || 0;
    const lastCheck = this.connectionChecks.get(url) || 0;
    const elapsed = Date.now() - lastCheck;

    if (streak < HEALTHY_STREAK_FOR_BACKOFF) {
      // Unhealthy or new: always check
      return true;
    }

    // Backoff: multiply interval by streak tier
    const backoffMultiplier = streak >= 4 ? 3 : 2;
    return elapsed >= this.HEALTH_CHECK_INTERVAL * backoffMultiplier;
  }

  /**
   * Perform batched health check on configured relays
   * Checks max BATCH_SIZE relays per cycle, prioritizing unhealthy ones
   */
  private async performHealthCheck(): Promise<void> {
    // Dynamically import to avoid circular dependencies
    const { RelayConfig } = await import('./RelayConfig');
    const { NostrTransport } = await import('./transport/NostrTransport');

    const relayConfig = RelayConfig.getInstance();
    const transport = NostrTransport.getInstance();

    const allRelays = relayConfig.getAllRelays();
    if (allRelays.length === 0) return;

    // First check: ping ALL relays to establish initial health status
    if (this.isFirstCheck) {
      this.isFirstCheck = false;
      for (const relay of allRelays) {
        this.pingRelay(relay.url, transport);
        this.connectionChecks.set(relay.url, Date.now());
      }
      return;
    }

    // Subsequent checks: batched with backoff
    const needsChecking = allRelays.filter(r => this.needsCheck(r.url));

    // Take a batch: prioritize unhealthy relays, then round-robin the rest
    const batch: { url: string }[] = [];

    // First: unhealthy relays (streak 0)
    const unhealthy = needsChecking.filter(
      r => (this.healthyStreaks.get(r.url) || 0) === 0
    );
    batch.push(...unhealthy.slice(0, BATCH_SIZE));

    // Fill remaining slots with healthy relays that need checking
    if (batch.length < BATCH_SIZE) {
      const healthy = needsChecking.filter(
        r => (this.healthyStreaks.get(r.url) || 0) > 0
      );
      const remaining = BATCH_SIZE - batch.length;
      // Round-robin through healthy relays
      const startIdx = this.batchIndex % Math.max(1, healthy.length);
      for (let i = 0; i < remaining && i < healthy.length; i++) {
        batch.push(healthy[(startIdx + i) % healthy.length]!);
      }
      this.batchIndex += remaining;
    }

    // Ping selected relays
    for (const relay of batch) {
      this.pingRelay(relay.url, transport);
      this.connectionChecks.set(relay.url, Date.now());
    }
  }

  /**
   * Ping a single relay to check health
   */
  private async pingRelay(relayUrl: string, transport: any): Promise<void> {
    const startTime = Date.now();
    let responded = false;

    try {
      // Create minimal subscription to test connectivity
      const sub = await transport.subscribe(
        [relayUrl],
        [{ kinds: [1], limit: 1 }], // Minimal filter
        {
          onEvent: () => {
            if (!responded) {
              responded = true;
              const latency = Date.now() - startTime;
              this.recordLatency(relayUrl, latency);
              this.eventBus.emit('relay:connected', { url: relayUrl, latency });
              sub.close();
            }
          },
          onEose: () => {
            if (!responded) {
              responded = true;
              const latency = Date.now() - startTime;
              this.eventBus.emit('relay:connected', { url: relayUrl, latency });
              sub.close();
            }
          },
        }
      );

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!responded) {
          this.eventBus.emit('relay:error', { url: relayUrl });
          sub.close();
        }
      }, 10000);
    } catch (error) {
      this.eventBus.emit('relay:error', { url: relayUrl });
    }
  }

  /**
   * Stop periodic health check (cleanup)
   */
  public stopPeriodicHealthCheck(): void {
    if (this.healthCheckInterval !== null) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }
}
