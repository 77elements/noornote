/**
 * RelayHealthMonitor Service
 * Monitors relay connection health, latency, and uptime
 *
 * @purpose Track relay health metrics for UI visibility and diagnostics
 * @architecture Singleton service, integrates with NostrTransport
 */

import { EventBus } from './EventBus';

export interface RelayHealthMetrics {
  url: string;
  isConnected: boolean;
  latency: number | null; // ms, null if never connected
  lastConnected: Date | null;
  lastDisconnected: Date | null;
  errorCount: number;
  uptimePercentage: number; // 0-100
}

export class RelayHealthMonitor {
  private static instance: RelayHealthMonitor;
  private metrics: Map<string, RelayHealthMetrics> = new Map();
  private eventBus: EventBus;
  private connectionChecks: Map<string, number> = new Map(); // url -> timestamp of last check
  private healthCheckInterval: number | null = null;
  private readonly HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

  private constructor() {
    this.eventBus = EventBus.getInstance();
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
    this.eventBus.on('relay:connected', (data: { url: string; latency?: number }) => {
      this.handleRelayConnected(data.url, data.latency);
    });

    this.eventBus.on('relay:disconnected', (data: { url: string }) => {
      this.handleRelayDisconnected(data.url);
    });

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
        uptimePercentage: 0
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

    this.updateUptimePercentage(url);
    this.eventBus.emit('relay:health:updated', { url, metrics });
  }

  /**
   * Handle relay disconnected event
   */
  private handleRelayDisconnected(url: string): void {
    const metrics = this.getOrCreateMetrics(url);
    metrics.isConnected = false;
    metrics.lastDisconnected = new Date();

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
      const hoursOffline = (Date.now() - metrics.lastDisconnected.getTime()) / (1000 * 60 * 60);
      metrics.uptimePercentage = Math.max(0, 100 - (hoursOffline * 10));
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
  public async getHealthSummary(): Promise<{ healthy: number; total: number; warnings: string[] }> {
    // Get all configured relays from RelayConfig
    const { RelayConfig } = await import('./RelayConfig');
    const relayConfig = RelayConfig.getInstance();
    const configuredRelays = relayConfig.getAllRelays();

    const total = configuredRelays.length;
    let healthy = 0;
    const warnings: string[] = [];

    // Check each configured relay's health status
    const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000);

    configuredRelays.forEach(relay => {
      const metrics = this.getMetrics(relay.url);

      if (metrics?.isConnected) {
        healthy++;
      } else if (metrics?.lastDisconnected) {
        // Relay has metrics but is disconnected
        const offlineTime = metrics.lastDisconnected.getTime();
        if (offlineTime < threeHoursAgo) {
          const hoursOffline = Math.floor((Date.now() - offlineTime) / (1000 * 60 * 60));
          warnings.push(`${relay.url} unreachable for ${hoursOffline}h - consider replacing`);
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
  }

  /**
   * Reset all metrics
   */
  public reset(): void {
    this.metrics.clear();
    this.connectionChecks.clear();
  }

  /**
   * Start periodic health check (every 5 minutes)
   */
  private startPeriodicHealthCheck(): void {
    // Initial check after 10 seconds
    setTimeout(() => this.performHealthCheck(), 10000);

    // Periodic checks every 5 minutes
    this.healthCheckInterval = window.setInterval(() => {
      this.performHealthCheck();
    }, this.HEALTH_CHECK_INTERVAL);
  }

  /**
   * Perform health check on all configured relays
   */
  private async performHealthCheck(): Promise<void> {
    // Dynamically import to avoid circular dependencies
    const { RelayConfig } = await import('./RelayConfig');
    const { NostrTransport } = await import('./transport/NostrTransport');

    const relayConfig = RelayConfig.getInstance();
    const transport = NostrTransport.getInstance();

    const allRelays = relayConfig.getAllRelays();

    // Ping each relay with minimal subscription
    for (const relay of allRelays) {
      this.pingRelay(relay.url, transport);
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
          }
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
