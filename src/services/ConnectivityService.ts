/**
 * ConnectivityService - Internet Connection Monitor
 * Checks and monitors internet connectivity status
 *
 * @purpose Detect offline state early to prevent cascade of errors
 * @architecture Singleton service, integrates with TypedEventBus
 */

import { TypedEventBus } from '../core/TypedEventBus';
import { ToastService } from './ToastService';
import { RelayHealthMonitor } from './RelayHealthMonitor';

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

      // Verify without any third-party request (browser onLine can be unreliable)
      const isReachable = this.verifyNetworkReachability();
      this.setOnlineStatus(isReachable);
      return isReachable;
    } finally {
      this.checkInProgress = false;
    }
  }

  /**
   * Verify reachability WITHOUT any third-party request.
   *
   * Privacy: we never ping Google/Cloudflare/etc — that would leak the user's
   * IP and online-timing to a passive observer on every check. A live relay
   * WebSocket is proof enough that we are online.
   *
   * If no relay is currently connected we cannot positively confirm, so we
   * fall back to the browser's navigator.onLine rather than falsely claiming
   * the user is offline — all relays being down is NOT the same as the
   * internet being down.
   */
  private verifyNetworkReachability(): boolean {
    const anyRelayConnected = RelayHealthMonitor.getInstance()
      .getAllMetrics()
      .some(m => m.isConnected);

    return anyRelayConnected || navigator.onLine;
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
