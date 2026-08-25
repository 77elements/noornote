/**
 * FollowerNotificationService
 * Owns the schedule for the follower-change detector: an initial check 3 minutes after start,
 * then every 3 hours while the app is open. The detector self-injects in-app notifications in
 * its live phase; this service only triggers it, guards against overlap, and persists timing.
 *
 * Lifecycle is driven by the addon runtime (init/destroy). Singleton with a nulled static
 * instance on destroy so account switches return a fresh instance (addon destroy contract).
 */

import { SystemLogger } from '../../services/SystemLogger';
import { PlatformService } from '../../services/PlatformService';
import { diagLog } from '../../services/DiagnosticLogger';
import { FollowerSnapshotStorage } from '../../lists/FollowerSnapshotStorage';
import { FollowerChangeDetector } from './FollowerChangeDetector';
import type { PluginListenerHandle } from '@capacitor/core';

export class FollowerNotificationService {
  private static instance: FollowerNotificationService | null = null;

  /** Re-check cadence while the app stays open. */
  private static readonly CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours
  /** Delay before the first check after start (lets login fetches settle). */
  private static readonly INITIAL_DELAY_MS = 3 * 60 * 1000; // 3 minutes
  /** Don't re-check if the last check was this recent (avoids re-sweeping on quick restarts). */
  private static readonly DUE_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

  private detector: FollowerChangeDetector;
  private storage: FollowerSnapshotStorage;
  private systemLogger: SystemLogger;

  private initialTimer: number | null = null;
  private interval: number | null = null;
  private running = false;
  private destroyed = false;
  private networkHandle: PluginListenerHandle | null = null;

  private constructor() {
    this.detector = FollowerChangeDetector.getInstance();
    this.storage = FollowerSnapshotStorage.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): FollowerNotificationService {
    if (!FollowerNotificationService.instance) {
      FollowerNotificationService.instance = new FollowerNotificationService();
    }
    return FollowerNotificationService.instance;
  }

  /** Start scheduling. Idempotent. */
  public async start(): Promise<void> {
    if (this.initialTimer !== null || this.interval !== null) return; // already running
    this.destroyed = false;

    await this.storage.initFromFile();
    if (this.destroyed) return;

    this.systemLogger.info(
      'FollowerNotificationService',
      'Started — first check in 3 min, then every 3 h'
    );
    diagLog('lists', 'follower-notification: scheduler started', {});

    this.initialTimer = window.setTimeout(() => {
      this.initialTimer = null;
      void this.tick();
      this.interval = window.setInterval(
        () => void this.tick(),
        FollowerNotificationService.CHECK_INTERVAL_MS
      );
    }, FollowerNotificationService.INITIAL_DELAY_MS);

    void this.setupWifiTrigger();
  }

  /**
   * Mobile: the full baseline sweep is deferred on cellular (see detector). Build it the moment WiFi
   * appears, instead of waiting for the next 3 h tick, but only while no baseline exists yet.
   */
  private async setupWifiTrigger(): Promise<void> {
    if (!PlatformService.getInstance().isCapacitor) return;
    try {
      const { Network } = await import('@capacitor/network');
      if (this.destroyed) return;
      this.networkHandle = await Network.addListener(
        'networkStatusChange',
        status => {
          if (
            status.connectionType === 'wifi' &&
            this.storage.getSnapshot() === null
          ) {
            void this.runCheck();
          }
        }
      );
      if (this.destroyed) {
        void this.networkHandle.remove();
        this.networkHandle = null;
      }
    } catch {
      // Plugin unavailable — the 3 h scheduler still retries the deferred baseline.
    }
  }

  /** A scheduled tick: run a check only if one is actually due. */
  private async tick(): Promise<void> {
    if (this.destroyed) return;
    const last = this.storage.getLastCheckTimestamp();
    if (
      last &&
      Date.now() - last <
        FollowerNotificationService.CHECK_INTERVAL_MS -
          FollowerNotificationService.DUE_MARGIN_MS
    ) {
      return; // checked recently (e.g. reopened soon after a check)
    }
    await this.runCheck();
  }

  /** Run one detection round. Forced (UI "check now") bypasses the due guard. */
  public async runCheck(): Promise<void> {
    if (this.destroyed || this.running) return;
    this.running = true;
    try {
      await this.detector.detect();
    } catch (error) {
      this.systemLogger.error(
        'FollowerNotificationService',
        `Check failed: ${String(error)}`
      );
    } finally {
      this.running = false;
    }
  }

  /** Acknowledge changes (advance the baseline, clear the unseen badge). */
  public async markAsSeen(): Promise<void> {
    await this.detector.markAsSeen();
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.initialTimer !== null) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.networkHandle) {
      void this.networkHandle.remove();
      this.networkHandle = null;
    }
    this.detector.cancel();
    FollowerNotificationService.instance = null;
  }
}
