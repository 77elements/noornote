/**
 * ConnectivityService - Internet Connection Monitor
 * Checks and monitors internet connectivity status
 *
 * @purpose Detect offline state early to prevent cascade of errors
 * @architecture Singleton service, integrates with TypedEventBus
 */

import { TypedEventBus } from '../core/TypedEventBus';
import { ToastService } from './ToastService';

export class ConnectivityService {
  private static instance: ConnectivityService;
  private eventBus: TypedEventBus;
  private _isOnline: boolean = true;
  private checkInProgress: boolean = false;
  private offlineTimer: number | null = null;
  private readonly OFFLINE_OVERLAY_DELAY = 120 * 1000; // 120 seconds

  // Track relay errors to detect connectivity issues
  private relayErrorCount: number = 0;
  private relayErrorResetTimer: number | null = null;
  private readonly RELAY_ERROR_THRESHOLD = 3; // Errors before checking connectivity
  private readonly RELAY_ERROR_WINDOW = 10 * 1000; // 10 second window

  private constructor() {
    this.eventBus = TypedEventBus.getInstance();
    this.setupBrowserListeners();
    this.setupRelayListeners();
  }

  public static getInstance(): ConnectivityService {
    if (!ConnectivityService.instance) {
      ConnectivityService.instance = new ConnectivityService();
    }
    return ConnectivityService.instance;
  }

  /**
   * Check if currently online
   */
  public isOnline(): boolean {
    return this._isOnline;
  }

  /**
   * Perform initial connectivity check
   * Returns true if online, false if offline
   */
  public async checkConnectivity(): Promise<boolean> {
    if (this.checkInProgress) {
      return this._isOnline;
    }

    this.checkInProgress = true;

    try {
      // First check browser's online status
      if (!navigator.onLine) {
        this.setOnlineStatus(false);
        return false;
      }

      // Verify with actual network request (browser onLine can be unreliable)
      const isReachable = await this.verifyNetworkReachability();
      this.setOnlineStatus(isReachable);
      return isReachable;
    } finally {
      this.checkInProgress = false;
    }
  }

  /**
   * Verify network reachability with actual request
   * Uses multiple endpoints for reliability
   */
  private async verifyNetworkReachability(): Promise<boolean> {
    const testEndpoints = [
      'https://www.google.com/generate_204',
      'https://connectivity-check.ubuntu.com/',
      'https://1.1.1.1/cdn-cgi/trace'
    ];

    for (const endpoint of testEndpoints) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        await fetch(endpoint, {
          method: 'HEAD',
          mode: 'no-cors',
          cache: 'no-store',
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        // no-cors mode returns opaque response, but if we get here without error, we're online
        return true;
      } catch {
        // Try next endpoint
        continue;
      }
    }

    return false;
  }

  /**
   * Set online status and emit event if changed
   */
  private setOnlineStatus(online: boolean): void {
    const wasOnline = this._isOnline;
    this._isOnline = online;

    if (wasOnline !== online) {
      this.eventBus.emit('connectivity:status', { online });

      if (!online) {
        this.handleWentOffline();
      } else {
        this.handleCameOnline();
      }
    }
  }

  /**
   * Handle transition to offline state
   * Shows toast immediately, starts timer for overlay
   */
  private handleWentOffline(): void {
    // Show immediate toast warning
    ToastService.show('Internet connection lost', 'warning', 5000);

    // Start timer for overlay (120 seconds)
    this.clearOfflineTimer();
    this.offlineTimer = window.setTimeout(() => {
      // Still offline after 120s - show overlay
      if (!this._isOnline) {
        this.eventBus.emit('connectivity:prolonged-offline');
      }
    }, this.OFFLINE_OVERLAY_DELAY);
  }

  /**
   * Handle transition to online state
   * Cancels overlay timer, shows success toast
   */
  private handleCameOnline(): void {
    this.clearOfflineTimer();
    this.resetRelayErrorCount();
    ToastService.show('Internet connection established', 'success');
  }

  /**
   * Clear the offline timer if running
   */
  private clearOfflineTimer(): void {
    if (this.offlineTimer !== null) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
    }
  }

  /**
   * Reset relay error count
   */
  private resetRelayErrorCount(): void {
    this.relayErrorCount = 0;
    if (this.relayErrorResetTimer !== null) {
      clearTimeout(this.relayErrorResetTimer);
      this.relayErrorResetTimer = null;
    }
  }

  /**
   * Setup browser online/offline event listeners
   */
  private setupBrowserListeners(): void {
    window.addEventListener('online', () => {
      // Browser reports online - verify with actual check
      this.checkConnectivity();
    });

    window.addEventListener('offline', () => {
      // Browser reports offline - trust immediately
      this.setOnlineStatus(false);
    });
  }

  /**
   * Listen to relay connection events from RelayHealthMonitor
   * Detects connectivity issues from relay errors
   */
  private setupRelayListeners(): void {
    // Relay connected - if we were offline, verify connectivity
    this.eventBus.on('relay:connected', () => {
      if (!this._isOnline) {
        this.checkConnectivity();
      }
      // Reset error count on successful connection
      this.resetRelayErrorCount();
    });

    // Relay error - track errors and check connectivity if threshold reached
    this.eventBus.on('relay:error', () => {
      if (!this._isOnline) return; // Already offline, no need to check

      this.relayErrorCount++;

      // Start/reset the error window timer
      if (this.relayErrorResetTimer !== null) {
        clearTimeout(this.relayErrorResetTimer);
      }
      this.relayErrorResetTimer = window.setTimeout(() => {
        this.relayErrorCount = 0;
      }, this.RELAY_ERROR_WINDOW);

      // If we hit threshold, check connectivity
      if (this.relayErrorCount >= this.RELAY_ERROR_THRESHOLD) {
        this.checkConnectivity();
        this.relayErrorCount = 0; // Reset after check
      }
    });
  }
}
