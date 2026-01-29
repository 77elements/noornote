/**
 * KeySignerClient - Client for NoorSigner daemon socket communication
 * Communicates with local key signer daemon via Unix socket (macOS/Linux)
 */

import { PlatformService } from './PlatformService';
import { decodeNip19 } from './NostrToolsAdapter';

interface SignerRequest {
  id: string;
  method: string;
  [key: string]: unknown;
}

interface SignResponse {
  id: string;
  signature?: string;
  error?: string;
}

export interface KeySignerAccount {
  pubkey: string;
  npub: string;
  created_at: number;
}

interface ListAccountsResponse {
  id: string;
  accounts?: KeySignerAccount[];
  active_pubkey?: string;
  error?: string;
}

interface SwitchAccountResponse {
  id: string;
  success?: boolean;
  pubkey?: string;
  npub?: string;
  error?: string;
}

interface AddAccountResponse {
  id: string;
  success?: boolean;
  pubkey?: string;
  npub?: string;
  error?: string;
}

interface RemoveAccountResponse {
  id: string;
  success?: boolean;
  error?: string;
}

interface ActiveAccountResponse {
  id: string;
  pubkey?: string;
  npub?: string;
  is_unlocked?: boolean;
  error?: string;
}

export class KeySignerClient {
  private static instance: KeySignerClient | null = null;
  private requestId = 0;
  private readonly timeout = 10000; // 10s timeout
  private lastSocketErrorTime = 0;
  private readonly SOCKET_ERROR_THROTTLE = 5000; // Log once every 5s

  // Connection state tracking
  private connectionState: 'connected' | 'reconnecting' | 'disconnected' = 'disconnected';
  private consecutiveFailures = 0;
  private readonly MAX_RETRY_ATTEMPTS = 3;
  private readonly RETRY_DELAY = 1000; // 1s between retries

  private constructor() {
    // Platform-specific socket path (unused - kept for reference)
    // Socket communication is handled by Tauri backend
  }

  public static getInstance(): KeySignerClient {
    if (!KeySignerClient.instance) {
      KeySignerClient.instance = new KeySignerClient();
    }
    return KeySignerClient.instance;
  }

  /**
   * Check if error is a transient connection error (reconnectable)
   */
  private isTransientError(errorMessage: string): boolean {
    return (
      errorMessage.includes('Broken pipe') ||
      errorMessage.includes('os error 32') ||
      errorMessage.includes('Connection reset') ||
      errorMessage.includes('EPIPE')
    );
  }

  /**
   * Get current connection state
   */
  public getConnectionState(): 'connected' | 'reconnecting' | 'disconnected' {
    return this.connectionState;
  }

  /**
   * Sleep helper for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Ensure we're running in Tauri
   */
  private ensureTauri(): void {
    if (!PlatformService.getInstance().isTauri) {
      throw new Error('KeySigner is only available in Tauri desktop app');
    }
  }

  /**
   * Build a request object with auto-incrementing ID
   */
  private buildRequest(method: string, params?: Record<string, unknown>): SignerRequest {
    return {
      id: `req-${++this.requestId}`,
      method,
      ...params,
    };
  }

  /**
   * Execute a Tauri invoke with timeout
   */
  private async invokeWithTimeout(request: SignerRequest): Promise<string> {
    const { invoke } = await import('@tauri-apps/api/core');

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('KeySigner request timeout')), this.timeout);
    });

    const invokePromise = invoke('key_signer_request', {
      request: JSON.stringify(request),
    });

    return Promise.race([invokePromise, timeoutPromise]) as Promise<string>;
  }

  /**
   * Handle connection errors with proper state management
   */
  private handleConnectionError(errorMessage: string): never {
    if (this.isTransientError(errorMessage)) {
      this.consecutiveFailures++;
      this.connectionState = 'reconnecting';
      console.log(`[KeySigner] Transient connection error (attempt ${this.consecutiveFailures}/${this.MAX_RETRY_ATTEMPTS}):`, errorMessage);
      throw new Error('KeySigner connection temporarily lost. Reconnecting...');
    }

    this.connectionState = 'disconnected';

    if (errorMessage.includes('timeout')) {
      console.error('[KeySigner] Request timeout - daemon may be unresponsive');
      throw new Error('KeySigner daemon is not responding. Please restart the daemon.');
    }

    if (errorMessage.includes('No such file or directory') || errorMessage.includes('os error 2')) {
      const now = Date.now();
      if (now - this.lastSocketErrorTime > this.SOCKET_ERROR_THROTTLE) {
        console.log('[KeySigner] Socket not found - daemon is not running');
        this.lastSocketErrorTime = now;
      }
      throw new Error('KeySigner daemon is not running. Please log in again.');
    }

    if (errorMessage.includes('Connection refused')) {
      console.error('[KeySigner] Connection refused - daemon crashed or stopped');
      throw new Error('KeySigner daemon connection failed. Please restart the daemon.');
    }

    console.error('[KeySigner] Request failed:', errorMessage);
    throw new Error(`KeySigner error: ${errorMessage}`);
  }

  /**
   * Send request to key signer daemon with timeout
   * Uses NoorSigner protocol: {id, method, event_json}
   */
  private async sendRequest(method: string, eventJson?: string): Promise<SignResponse> {
    this.ensureTauri();

    const request = this.buildRequest(method, eventJson ? { event_json: eventJson } : undefined);

    try {
      const responseStr = await this.invokeWithTimeout(request);
      const response: SignResponse = JSON.parse(responseStr);

      if (response.error) {
        throw new Error(`KeySigner error: ${response.error}`);
      }

      this.consecutiveFailures = 0;
      this.connectionState = 'connected';

      return response;
    } catch (_error) {
      const errorMessage = _error instanceof Error ? _error.message : String(_error);
      this.handleConnectionError(errorMessage);
    }
  }

  /**
   * Send a custom request with arbitrary parameters
   */
  private async sendCustomRequest<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.ensureTauri();

    const request = this.buildRequest(method, params);

    try {
      const responseStr = await this.invokeWithTimeout(request);
      return JSON.parse(responseStr) as T;
    } catch (_error) {
      const errorMessage = _error instanceof Error ? _error.message : String(_error);
      throw new Error(`${method} failed: ${errorMessage}`);
    }
  }

  /**
   * Get public key (npub) from key signer
   */
  public async getNpub(): Promise<string> {
    const response = await this.sendRequest('get_npub');
    // Daemon returns npub in 'signature' field (reused field)
    return response.signature || '';
  }

  /**
   * Get public key (hex) from key signer
   * Note: Daemon doesn't have this method, we convert from npub
   */
  public async getPubkey(): Promise<string> {
    const npub = await this.getNpub();
    const decoded = decodeNip19(npub);
    if (decoded.type === 'npub') {
      return decoded.data as string;
    }
    throw new Error('Invalid npub from daemon');
  }

  /**
   * Sign a Nostr event
   */
  public async signEvent(event: any): Promise<any> {
    const eventJson = JSON.stringify(event);
    const response = await this.sendRequest('sign_event', eventJson);
    return response.signature;
  }

  /**
   * Encrypt plaintext using NIP-44 (for recipient)
   */
  public async nip44Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    const response = await this.sendCustomRequest<SignResponse>('nip44_encrypt', {
      plaintext,
      recipient_pubkey: recipientPubkey,
    });
    if (response.error) {
      throw new Error(`NIP-44 encrypt error: ${response.error}`);
    }
    return response.signature || '';
  }

  /**
   * Decrypt NIP-44 payload (from sender)
   */
  public async nip44Decrypt(payload: string, senderPubkey: string): Promise<string> {
    const response = await this.sendCustomRequest<SignResponse>('nip44_decrypt', {
      payload,
      sender_pubkey: senderPubkey,
    });
    if (response.error) {
      throw new Error(`NIP-44 decrypt error: ${response.error}`);
    }
    return response.signature || '';
  }

  /**
   * Encrypt plaintext using NIP-04 (for recipient)
   * NIP-04 is deprecated but widely compatible
   */
  public async nip04Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    const response = await this.sendCustomRequest<SignResponse>('nip04_encrypt', {
      plaintext,
      recipient_pubkey: recipientPubkey,
    });
    if (response.error) {
      throw new Error(`NIP-04 encrypt error: ${response.error}`);
    }
    return response.signature || '';
  }

  /**
   * Decrypt NIP-04 payload (from sender)
   * NIP-04 is deprecated but widely compatible
   */
  public async nip04Decrypt(payload: string, senderPubkey: string): Promise<string> {
    const response = await this.sendCustomRequest<SignResponse>('nip04_decrypt', {
      payload,
      sender_pubkey: senderPubkey,
    });
    if (response.error) {
      throw new Error(`NIP-04 decrypt error: ${response.error}`);
    }
    return response.signature || '';
  }

  /**
   * Check if key signer daemon is running
   * Uses retry logic for transient errors (broken pipe, connection reset)
   * Only returns false if daemon is truly not running or max retries exceeded
   */
  public async isRunning(): Promise<boolean> {
    let attempts = 0;

    while (attempts < this.MAX_RETRY_ATTEMPTS) {
      try {
        await this.sendRequest('get_npub');
        // Success - daemon is running
        return true;
      } catch (_error) {
        const errorMessage = _error instanceof Error ? _error.message : String(_error);

        // If it's a transient error, retry
        if (this.isTransientError(errorMessage) && attempts < this.MAX_RETRY_ATTEMPTS - 1) {
          attempts++;
          console.log(`[KeySigner] Retrying connection check (${attempts}/${this.MAX_RETRY_ATTEMPTS})...`);
          await this.sleep(this.RETRY_DELAY);
          continue;
        }

        // Permanent error or max retries exceeded
        return false;
      }
    }

    // Max retries exceeded
    return false;
  }

  /**
   * Enable autostart for daemon
   */
  public async enableAutostart(): Promise<void> {
    const response = await this.sendRequest('enable_autostart');
    if (response.error) {
      throw new Error(response.error);
    }
  }

  /**
   * Disable autostart for daemon
   */
  public async disableAutostart(): Promise<void> {
    const response = await this.sendRequest('disable_autostart');
    if (response.error) {
      throw new Error(response.error);
    }
  }

  /**
   * Get autostart status
   */
  public async getAutostartStatus(): Promise<boolean> {
    const response = await this.sendRequest('get_autostart_status');
    if (response.error) {
      throw new Error(response.error);
    }
    // Daemon returns 'enabled' or 'disabled' in signature field
    return response.signature === 'enabled';
  }

  /**
   * Check if Trust Mode session is valid
   */
  public async checkTrustSession(): Promise<boolean> {
    if (!PlatformService.getInstance().isTauri) {
      return false;
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<boolean>('check_trust_session');
    } catch (error) {
      console.error('Failed to check trust session:', error);
      return false;
    }
  }

  /**
   * Stop (shutdown) the daemon gracefully
   */
  public async stopDaemon(): Promise<void> {
    const response = await this.sendRequest('shutdown_daemon');
    if (response.error) {
      throw new Error(response.error);
    }
  }

  /**
   * Launch NoorSigner with specified mode
   */
  private async launchSigner(mode: 'daemon' | 'init'): Promise<void> {
    this.ensureTauri();

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('launch_key_signer', { mode });
    } catch (error) {
      console.error(`Failed to launch KeySigner ${mode}:`, error);
      throw error;
    }
  }

  /**
   * Launch NoorSigner daemon (via Tauri command)
   */
  public async launchDaemon(): Promise<void> {
    return this.launchSigner('daemon');
  }

  /**
   * Launch NoorSigner init (first-time setup)
   */
  public async launchInit(): Promise<void> {
    return this.launchSigner('init');
  }

  /**
   * List all accounts stored in NoorSigner
   */
  public async listAccounts(): Promise<{ accounts: KeySignerAccount[]; activePubkey: string }> {
    const response = await this.sendCustomRequest<ListAccountsResponse>('list_accounts');
    if (response.error) {
      throw new Error(response.error);
    }
    return {
      accounts: response.accounts || [],
      activePubkey: response.active_pubkey || '',
    };
  }

  /**
   * Switch to a different account in NoorSigner
   * Requires password for the target account
   */
  public async switchAccount(npub: string, password: string): Promise<{ pubkey: string; npub: string }> {
    const response = await this.sendCustomRequest<SwitchAccountResponse>('switch_account', {
      npub,
      password,
    });
    if (response.error) {
      throw new Error(response.error);
    }
    if (!response.success) {
      throw new Error('Account switch failed');
    }
    return {
      pubkey: response.pubkey || '',
      npub: response.npub || '',
    };
  }

  /**
   * Add a new account to NoorSigner
   */
  public async addAccount(
    nsec: string,
    password: string,
    setActive = false
  ): Promise<{ pubkey: string; npub: string }> {
    const response = await this.sendCustomRequest<AddAccountResponse>('add_account', {
      nsec,
      password,
      set_active: setActive,
    });
    if (response.error) {
      throw new Error(response.error);
    }
    if (!response.success) {
      throw new Error('Failed to add account');
    }
    return {
      pubkey: response.pubkey || '',
      npub: response.npub || '',
    };
  }

  /**
   * Remove an account from NoorSigner
   * Note: Cannot remove the currently active account
   */
  public async removeAccount(pubkey: string, password: string): Promise<boolean> {
    const response = await this.sendCustomRequest<RemoveAccountResponse>('remove_account', {
      pubkey,
      password,
    });
    if (response.error) {
      throw new Error(response.error);
    }
    return response.success || false;
  }

  /**
   * Get the currently active account info
   */
  public async getActiveAccount(): Promise<{
    pubkey: string;
    npub: string;
    isUnlocked: boolean;
  }> {
    const response = await this.sendCustomRequest<ActiveAccountResponse>('get_active_account');
    if (response.error) {
      throw new Error(response.error);
    }
    return {
      pubkey: response.pubkey || '',
      npub: response.npub || '',
      isUnlocked: response.is_unlocked || false,
    };
  }

  /**
   * Add account via CLI (when daemon is NOT running)
   * Uses noorsigner add-account --stdin
   */
  public async addAccountViaCli(
    nsec: string,
    password: string
  ): Promise<{ pubkey: string; npub: string }> {
    this.ensureTauri();

    const { invoke } = await import('@tauri-apps/api/core');
    const jsonInput = JSON.stringify({ nsec, password });

    try {
      const responseStr = await invoke<string>('add_account_via_cli', { jsonInput });
      const response = JSON.parse(responseStr);

      if (!response.success) {
        throw new Error(response.error || 'Failed to add account');
      }

      return {
        pubkey: response.pubkey || '',
        npub: response.npub || '',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to add account: ${message}`);
    }
  }

  /**
   * Launch NoorSigner daemon with password (silent, no terminal)
   * Used when trust session is expired and silent mode is enabled
   */
  public async launchDaemonWithPassword(password: string): Promise<string> {
    this.ensureTauri();
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('launch_daemon_with_password', { password });
  }

  /**
   * Check if any NoorSigner accounts exist on disk
   */
  public async hasAccounts(): Promise<boolean> {
    this.ensureTauri();
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<boolean>('has_noorsigner_accounts');
  }

  /**
   * Destroy instance
   */
  public static destroy(): void {
    KeySignerClient.instance = null;
  }
}
