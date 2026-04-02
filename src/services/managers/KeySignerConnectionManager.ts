/**
 * KeySignerConnectionManager
 * Manages KeySigner daemon connection, polling, and health monitoring
 *
 * @purpose Handle KeySigner-specific connection logic separate from core auth
 * @used-by AuthService
 */

import { KeySignerClient } from '../KeySignerClient';
import { PlatformService } from '../PlatformService';
import { SystemLogger } from '../../components/system/SystemLogger';

export interface KeySignerAuthResult {
  success: boolean;
  npub?: string;
  pubkey?: string;
  error?: string;
  needsPassword?: boolean;
  needsImport?: boolean;
}

const SILENT_MODE_KEY = 'noorsigner_silent_mode';

export class KeySignerConnectionManager {
  private keySigner: KeySignerClient | null = null;
  private logger: SystemLogger;
  private daemonPollingInterval: NodeJS.Timeout | null = null;
  private readonly DAEMON_POLL_INTERVAL = 5000; // Poll every 5 seconds
  private daemonFailureCount = 0;
  private readonly MAX_DAEMON_FAILURES = 6; // Allow 6 failures (30s grace period) before logout
  private windowFocused = true;
  private keySignerAbortController: AbortController | null = null;
  private onDaemonLost?: () => void;

  constructor() {
    this.logger = SystemLogger.getInstance();
    this.setupWindowFocusListeners();
  }

  /**
   * Set callback for when daemon connection is lost
   */
  public onConnectionLost(callback: () => void): void {
    this.onDaemonLost = callback;
  }

  /**
   * Setup window focus/blur listeners for adaptive daemon polling
   */
  private setupWindowFocusListeners(): void {
    if (!PlatformService.getInstance().isDesktop) return;

    window.addEventListener('focus', () => {
      this.windowFocused = true;

      if (this.keySigner && !this.daemonPollingInterval) {
        this.startDaemonPolling();
      }
    });

    window.addEventListener('blur', () => {
      this.windowFocused = false;
    });
  }

  /**
   * Try auto-login with KeySigner
   */
  public async tryAutoLogin(): Promise<{ success: boolean; npub?: string; pubkey?: string; error?: string }> {
    if (!PlatformService.getInstance().isDesktop) {
      return { success: false, error: 'Not running on desktop' };
    }

    try {
      this.logger.info('KeySigner', 'Attempting auto-login...');
      this.keySigner = KeySignerClient.getInstance();

      const isRunning = await this.keySigner.isRunning();
      if (!isRunning) {
        this.logger.info('KeySigner', 'Daemon not running, auto-login skipped');
        this.keySigner = null;
        return { success: false, error: 'Daemon not running' };
      }

      const pubkey = await this.keySigner.getPubkey();
      if (pubkey) {
        this.logger.success('KeySigner', 'Auto-login successful');
        const { hexToNpub } = await import('../../helpers/nip19');
        const npub = await hexToNpub(pubkey);

        if (!npub) {
          this.keySigner = null;
          return { success: false, error: 'Failed to convert pubkey to npub' };
        }

        this.startDaemonPolling();

        return { success: true, npub, pubkey };
      }

      this.keySigner = null;
      return { success: false, error: 'No pubkey available' };
    } catch (_error) {
      this.logger.error('KeySigner', `Auto-login failed: ${_error}`);
      this.keySigner = null;
      return { success: false, error: String(_error) };
    }
  }

  /**
   * Check if silent mode is enabled
   */
  public isSilentMode(): boolean {
    return localStorage.getItem(SILENT_MODE_KEY) !== 'false';
  }

  /**
   * Authenticate with KeySigner
   */
  public async authenticate(): Promise<KeySignerAuthResult> {
    if (!PlatformService.getInstance().isDesktop) {
      return { success: false, error: 'KeySigner only available on desktop' };
    }

    try {
      this.keySigner = KeySignerClient.getInstance();

      this.logger.info('KeySigner', 'Checking if daemon is running...');
      const isRunning = await this.keySigner.isRunning();

      if (!isRunning) {
        if (this.isSilentMode()) {
          return this.authenticateSilent();
        }

        // Terminal mode (default): launch with terminal fallback
        this.logger.info('KeySigner', 'Daemon not running, launching...');
        await this.keySigner.launchDaemon();

        const maxWaitTime = 300000; // 5 minutes for first-time setup (nsec + password)
        const pollInterval = 1000;
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));

          const isNowRunning = await this.keySigner.isRunning();
          if (isNowRunning) {
            this.logger.success('KeySigner', 'Daemon is now running');
            break;
          }
        }

        const finalCheck = await this.keySigner.isRunning();
        if (!finalCheck) {
          this.keySigner = null;
          return {
            success: false,
            error: 'Daemon did not start. Please complete the setup in the terminal window and try again.'
          };
        }
      }

      return this.finishAuthentication();
    } catch (_error: any) {
      this.logger.error('KeySigner', `Authentication failed: ${_error}`);

      if (_error.name === 'AbortError') {
        this.logger.info('KeySigner', 'Login cancelled by user');
        return { success: false, error: 'Login cancelled' };
      }

      this.keySigner = null;
      return { success: false, error: String(_error) };
    } finally {
      this.keySignerAbortController = null;
    }
  }

  /**
   * Silent mode authentication: check state first, then launch or prompt
   */
  private async authenticateSilent(): Promise<KeySignerAuthResult> {
    this.logger.info('KeySigner', 'Silent mode: checking state...');

    // Check accounts and trust session BEFORE trying to launch
    const hasAccounts = await this.keySigner!.hasAccounts();
    if (!hasAccounts) {
      this.logger.info('KeySigner', 'No accounts found — import needed');
      this.keySigner = null;
      return { success: false, needsImport: true };
    }

    const hasTrust = await this.keySigner!.checkTrustSession();
    if (!hasTrust) {
      this.logger.info('KeySigner', 'Trust session expired — starting daemon, then password needed');
      // Start daemon process FIRST (waits for password on stdin)
      // so it's already running when the password modal appears
      try {
        await this.keySigner!.prepareDaemonForUnlock();
        this.logger.info('KeySigner', 'Daemon process started, waiting for password');
      } catch (_error) {
        this.logger.warn('KeySigner', `Failed to prepare daemon: ${_error}`);
      }
      this.keySigner = null;
      return { success: false, needsPassword: true };
    }

    // Trust session valid — launch daemon silently
    this.logger.info('KeySigner', 'Trust session valid, launching daemon silently...');
    try {
      if (PlatformService.getInstance().isElectron) {
        await window.electronAPI!.launchDaemonSilent();
      }
    } catch (_error) {
      this.logger.warn('KeySigner', `Silent launch invoke failed: ${_error}`);
    }

    // Wait for daemon to start
    const maxWait = 3000;
    const pollInterval = 200;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      const running = await this.keySigner!.isRunning();
      if (running) {
        this.logger.success('KeySigner', 'Silent launch successful');
        return this.finishAuthentication();
      }
    }

    // Fallback: trust session seemed valid but daemon didn't start
    this.logger.warn('KeySigner', 'Daemon did not start despite valid trust session');
    this.keySigner = null;
    return { success: false, needsPassword: true };
  }

  /**
   * Complete authentication after daemon is confirmed running
   */
  private async finishAuthentication(): Promise<KeySignerAuthResult> {
    this.keySignerAbortController = new AbortController();

    this.logger.info('KeySigner', 'Getting pubkey...');
    const pubkey = await this.keySigner!.getPubkey();

    if (!pubkey) {
      throw new Error('Failed to get pubkey from KeySigner');
    }

    this.logger.success('KeySigner', `Got pubkey: ${pubkey.slice(0, 8)}...`);

    const { hexToNpub } = await import('../../helpers/nip19');
    const npub = await hexToNpub(pubkey);

    if (!npub) {
      this.keySigner = null;
      return { success: false, error: 'Failed to convert pubkey to npub' };
    }

    this.startDaemonPolling();

    return { success: true, npub, pubkey };
  }

  /**
   * Cancel ongoing KeySigner login
   */
  public async cancelLogin(): Promise<void> {
    if (this.keySignerAbortController) {
      this.logger.info('KeySigner', 'Cancelling login...');
      this.keySignerAbortController.abort();
      this.keySignerAbortController = null;
    }

    if (this.keySigner) {
      this.keySigner = null;
    }
  }

  /**
   * Start daemon health polling
   */
  public startDaemonPolling(): void {
    if (this.daemonPollingInterval || !this.keySigner) return;

    this.logger.info('KeySigner', 'Starting daemon health polling');
    this.daemonFailureCount = 0;

    this.daemonPollingInterval = setInterval(async () => {
      if (!this.windowFocused) {
        return;
      }

      try {
        const isRunning = await this.keySigner!.isRunning();

        if (!isRunning) {
          this.daemonFailureCount++;
          this.logger.warn('KeySigner', `Daemon check failed (${this.daemonFailureCount}/${this.MAX_DAEMON_FAILURES})`);

          if (this.daemonFailureCount >= this.MAX_DAEMON_FAILURES) {
            this.logger.error('KeySigner', 'Daemon connection lost - logging out');
            this.stopDaemonPolling();
            this.onDaemonLost?.();

            const { ToastService } = await import('../ToastService');
            ToastService.show('KeySigner daemon connection lost', 'error');
          }
        } else {
          if (this.daemonFailureCount > 0) {
            this.logger.success('KeySigner', 'Connection restored');
            this.daemonFailureCount = 0;
          }
        }
      } catch (_error: any) {
        const isTransientError = _error.message?.includes('Broken pipe') ||
                                  _error.message?.includes('os error 32');

        if (isTransientError) {
          this.daemonFailureCount++;
          this.logger.warn('KeySigner', `Transient error (${this.daemonFailureCount}/${this.MAX_DAEMON_FAILURES}): ${_error.message}`);

          if (this.daemonFailureCount >= this.MAX_DAEMON_FAILURES) {
            this.logger.error('KeySigner', 'Too many transient errors - logging out');
            this.stopDaemonPolling();
            this.onDaemonLost?.();

            const { ToastService } = await import('../ToastService');
            ToastService.show('KeySigner connection unstable - logged out', 'error');
          }
        } else {
          this.logger.error('KeySigner', `Daemon polling error: ${_error}`);
        }
      }
    }, this.DAEMON_POLL_INTERVAL);
  }

  /**
   * Stop daemon health polling
   */
  public stopDaemonPolling(): void {
    if (this.daemonPollingInterval) {
      this.logger.info('KeySigner', 'Stopping daemon health polling');
      clearInterval(this.daemonPollingInterval);
      this.daemonPollingInterval = null;
      this.daemonFailureCount = 0;
    }
  }

  /**
   * Ask user if they want to stop the daemon
   */
  public async askStopDaemon(): Promise<boolean> {
    if (!this.keySigner) return false;

    try {
      const isRunning = await this.keySigner.isRunning();
      if (!isRunning) return false;

      const { ModalService } = await import('../ModalService');
      const modalService = ModalService.getInstance();

      const confirmed = await modalService.confirm({
        title: 'Stop NoorSigner Daemon?',
        message: 'Do you want to stop the NoorSigner daemon process? This will end all active signing sessions.',
        confirmText: 'Stop Daemon',
        cancelText: 'Keep Running',
        confirmDestructive: true
      });

      if (!confirmed) {
        return false;
      }

      try {
        await this.keySigner!.stopDaemon();
        this.logger.success('KeySigner', 'Daemon stopped successfully');
        return true;
      } catch (_error) {
        this.logger.error('KeySigner', `Failed to stop daemon: ${_error}`);
        const { ToastService } = await import('../ToastService');
        ToastService.show('Failed to stop daemon', 'error');
        return false;
      }
    } catch (_error) {
      this.logger.error('KeySigner', `Error checking daemon status: ${_error}`);
      return false;
    }
  }

  /**
   * Get KeySigner client
   */
  public getClient(): KeySignerClient | null {
    return this.keySigner;
  }

  /**
   * Clear KeySigner client
   */
  public clear(): void {
    this.stopDaemonPolling();
    this.keySigner = null;
    this.daemonFailureCount = 0;
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    this.stopDaemonPolling();
    this.keySigner = null;
  }
}
