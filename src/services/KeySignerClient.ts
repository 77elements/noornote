/**
 * KeySignerClient - Client for NoorSigner daemon socket communication
 * Communicates with local key signer daemon via Unix socket (macOS/Linux)
 *
 * Uses Electron (window.electronAPI) backend.
 */

import { errMessage } from '../helpers/errorMessage';
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
  private connectionState: 'connected' | 'reconnecting' | 'disconnected' =
    'disconnected';
  private consecutiveFailures = 0;
  private readonly MAX_RETRY_ATTEMPTS = 3;
  private readonly RETRY_DELAY = 1000; // 1s between retries

  private constructor() {}

  public static getInstance(): KeySignerClient {
    if (!KeySignerClient.instance) {
      KeySignerClient.instance = new KeySignerClient();
    }
    return KeySignerClient.instance;
  }

  private isTransientError(errorMessage: string): boolean {
    return (
      errorMessage.includes('Broken pipe') ||
      errorMessage.includes('os error 32') ||
      errorMessage.includes('Connection reset') ||
      errorMessage.includes('EPIPE')
    );
  }

  public getConnectionState(): 'connected' | 'reconnecting' | 'disconnected' {
    return this.connectionState;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Ensure we're running on a desktop platform (Electron)
   */
  private ensureDesktop(): void {
    const platform = PlatformService.getInstance();
    if (!platform.isDesktop) {
      throw new Error('KeySigner is only available in desktop app');
    }
  }

  private buildRequest(
    method: string,
    params?: Record<string, unknown>
  ): SignerRequest {
    return {
      id: `req-${++this.requestId}`,
      method,
      ...params,
    };
  }

  /**
   * Execute a key signer request with timeout.
   * Routes to Electron IPC.
   */
  private async invokeWithTimeout(request: SignerRequest): Promise<string> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error('KeySigner request timeout')),
        this.timeout
      );
    });

    const invokePromise = window.electronAPI!.keySignerRequest(
      JSON.stringify(request)
    );

    return Promise.race([invokePromise, timeoutPromise]) as Promise<string>;
  }

  private handleConnectionError(errorMessage: string): never {
    if (this.isTransientError(errorMessage)) {
      this.consecutiveFailures++;
      this.connectionState = 'reconnecting';
      console.debug(
        `[KeySigner] Transient connection error (attempt ${this.consecutiveFailures}/${this.MAX_RETRY_ATTEMPTS}):`,
        errorMessage
      );
      throw new Error('KeySigner connection temporarily lost. Reconnecting...');
    }

    this.connectionState = 'disconnected';

    if (errorMessage.includes('timeout')) {
      console.error('[KeySigner] Request timeout - daemon may be unresponsive');
      throw new Error(
        'KeySigner daemon is not responding. Please restart the daemon.'
      );
    }

    if (
      errorMessage.includes('No such file or directory') ||
      errorMessage.includes('os error 2')
    ) {
      const now = Date.now();
      if (now - this.lastSocketErrorTime > this.SOCKET_ERROR_THROTTLE) {
        console.debug('[KeySigner] Socket not found - daemon is not running');
        this.lastSocketErrorTime = now;
      }
      throw new Error('KeySigner daemon is not running. Please log in again.');
    }

    if (errorMessage.includes('Connection refused')) {
      console.error(
        '[KeySigner] Connection refused - daemon crashed or stopped'
      );
      throw new Error(
        'KeySigner daemon connection failed. Please restart the daemon.'
      );
    }

    console.error('[KeySigner] Request failed:', errorMessage);
    throw new Error(`KeySigner error: ${errorMessage}`);
  }

  private async sendRequest(
    method: string,
    eventJson?: string
  ): Promise<SignResponse> {
    this.ensureDesktop();

    const request = this.buildRequest(
      method,
      eventJson ? { event_json: eventJson } : undefined
    );

    try {
      const responseStr = await this.invokeWithTimeout(request);
      const response = JSON.parse(responseStr) as SignResponse;

      if (response.error) {
        throw new Error(`KeySigner error: ${response.error}`);
      }

      this.consecutiveFailures = 0;
      this.connectionState = 'connected';

      return response;
    } catch (_error) {
      const errorMessage =
        _error instanceof Error ? _error.message : String(_error);
      this.handleConnectionError(errorMessage);
    }
  }

  private async sendCustomRequest<T>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    this.ensureDesktop();

    const request = this.buildRequest(method, params);

    try {
      const responseStr = await this.invokeWithTimeout(request);
      return JSON.parse(responseStr) as T;
    } catch (_error) {
      const errorMessage =
        _error instanceof Error ? _error.message : String(_error);
      throw new Error(`${method} failed: ${errorMessage}`);
    }
  }

  public async getNpub(): Promise<string> {
    const response = await this.sendRequest('get_npub');
    return response.signature || '';
  }

  public async getPubkey(): Promise<string> {
    const npub = await this.getNpub();
    const decoded = decodeNip19(npub);
    if (decoded.type === 'npub') {
      return decoded.data as string;
    }
    throw new Error('Invalid npub from daemon');
  }

  public async signEvent(event: unknown): Promise<string> {
    const eventJson = JSON.stringify(event);
    const response = await this.sendRequest('sign_event', eventJson);
    return response.signature || '';
  }

  public async nip44Encrypt(
    plaintext: string,
    recipientPubkey: string
  ): Promise<string> {
    const response = await this.sendCustomRequest<SignResponse>(
      'nip44_encrypt',
      {
        plaintext,
        recipient_pubkey: recipientPubkey,
      }
    );
    if (response.error) {
      throw new Error(`NIP-44 encrypt error: ${response.error}`);
    }
    return response.signature || '';
  }

  public async nip44Decrypt(
    payload: string,
    senderPubkey: string
  ): Promise<string> {
    const response = await this.sendCustomRequest<SignResponse>(
      'nip44_decrypt',
      {
        payload,
        sender_pubkey: senderPubkey,
      }
    );
    if (response.error) {
      throw new Error(`NIP-44 decrypt error: ${response.error}`);
    }
    return response.signature || '';
  }

  public async nip04Encrypt(
    plaintext: string,
    recipientPubkey: string
  ): Promise<string> {
    const response = await this.sendCustomRequest<SignResponse>(
      'nip04_encrypt',
      {
        plaintext,
        recipient_pubkey: recipientPubkey,
      }
    );
    if (response.error) {
      throw new Error(`NIP-04 encrypt error: ${response.error}`);
    }
    return response.signature || '';
  }

  public async nip04Decrypt(
    payload: string,
    senderPubkey: string
  ): Promise<string> {
    const response = await this.sendCustomRequest<SignResponse>(
      'nip04_decrypt',
      {
        payload,
        sender_pubkey: senderPubkey,
      }
    );
    if (response.error) {
      throw new Error(`NIP-04 decrypt error: ${response.error}`);
    }
    return response.signature || '';
  }

  public async isRunning(): Promise<boolean> {
    let attempts = 0;

    while (attempts < this.MAX_RETRY_ATTEMPTS) {
      try {
        await this.sendRequest('get_npub');
        return true;
      } catch (_error) {
        const errorMessage =
          _error instanceof Error ? _error.message : String(_error);

        if (
          this.isTransientError(errorMessage) &&
          attempts < this.MAX_RETRY_ATTEMPTS - 1
        ) {
          attempts++;
          console.debug(
            `[KeySigner] Retrying connection check (${attempts}/${this.MAX_RETRY_ATTEMPTS})...`
          );
          await this.sleep(this.RETRY_DELAY);
          continue;
        }

        return false;
      }
    }

    return false;
  }

  public async enableAutostart(): Promise<void> {
    const response = await this.sendRequest('enable_autostart');
    if (response.error) throw new Error(response.error);
  }

  public async disableAutostart(): Promise<void> {
    const response = await this.sendRequest('disable_autostart');
    if (response.error) throw new Error(response.error);
  }

  public async getAutostartStatus(): Promise<boolean> {
    const response = await this.sendRequest('get_autostart_status');
    if (response.error) throw new Error(response.error);
    return response.signature === 'enabled';
  }

  public async checkTrustSession(): Promise<boolean> {
    const platform = PlatformService.getInstance();
    if (!platform.isDesktop) return false;

    try {
      return await window.electronAPI!.checkTrustSession();
    } catch (error) {
      console.error('Failed to check trust session:', error);
      return false;
    }
  }

  public async stopDaemon(): Promise<void> {
    const response = await this.sendRequest('shutdown_daemon');
    if (response.error) throw new Error(response.error);
  }

  private async launchSigner(mode: 'daemon' | 'init'): Promise<void> {
    this.ensureDesktop();

    try {
      await window.electronAPI!.launchKeySigner(mode);
    } catch (error) {
      console.error(`Failed to launch KeySigner ${mode}:`, error);
      throw error;
    }
  }

  public async launchDaemon(): Promise<void> {
    return this.launchSigner('daemon');
  }

  public async launchInit(): Promise<void> {
    return this.launchSigner('init');
  }

  public async listAccounts(): Promise<{
    accounts: KeySignerAccount[];
    activePubkey: string;
  }> {
    const response =
      await this.sendCustomRequest<ListAccountsResponse>('list_accounts');
    if (response.error) throw new Error(response.error);
    return {
      accounts: response.accounts || [],
      activePubkey: response.active_pubkey || '',
    };
  }

  public async switchAccount(
    npub: string,
    password: string
  ): Promise<{ pubkey: string; npub: string }> {
    const response = await this.sendCustomRequest<SwitchAccountResponse>(
      'switch_account',
      {
        npub,
        password,
      }
    );
    if (response.error) throw new Error(response.error);
    if (!response.success) throw new Error('Account switch failed');
    return {
      pubkey: response.pubkey || '',
      npub: response.npub || '',
    };
  }

  public async addAccount(
    nsec: string,
    password: string,
    setActive = false
  ): Promise<{ pubkey: string; npub: string }> {
    const response = await this.sendCustomRequest<AddAccountResponse>(
      'add_account',
      {
        nsec,
        password,
        set_active: setActive,
      }
    );
    if (response.error) throw new Error(response.error);
    if (!response.success) throw new Error('Failed to add account');
    return {
      pubkey: response.pubkey || '',
      npub: response.npub || '',
    };
  }

  public async removeAccount(
    pubkey: string,
    password: string
  ): Promise<boolean> {
    const response = await this.sendCustomRequest<RemoveAccountResponse>(
      'remove_account',
      {
        pubkey,
        password,
      }
    );
    if (response.error) throw new Error(response.error);
    return response.success || false;
  }

  public async getActiveAccount(): Promise<{
    pubkey: string;
    npub: string;
    isUnlocked: boolean;
  }> {
    const response =
      await this.sendCustomRequest<ActiveAccountResponse>('get_active_account');
    if (response.error) throw new Error(response.error);
    return {
      pubkey: response.pubkey || '',
      npub: response.npub || '',
      isUnlocked: response.is_unlocked || false,
    };
  }

  public async addAccountViaCli(
    nsec: string,
    password: string
  ): Promise<{ pubkey: string; npub: string }> {
    this.ensureDesktop();

    const jsonInput = JSON.stringify({ nsec, password });

    try {
      const responseStr = await window.electronAPI!.addAccountViaCli(jsonInput);
      // Electron IPC bridge response (daemon CLI output)
      const response = JSON.parse(responseStr) as {
        success?: boolean;
        error?: string;
        pubkey?: string;
        npub?: string;
      };

      if (!response.success) {
        throw new Error(response.error || 'Failed to add account');
      }

      return {
        pubkey: response.pubkey || '',
        npub: response.npub || '',
      };
    } catch (error) {
      const message = errMessage(error);
      throw new Error(`Failed to add account: ${message}`);
    }
  }

  public async launchDaemonWithPassword(password: string): Promise<string> {
    this.ensureDesktop();
    return window.electronAPI!.launchDaemonWithPassword(password);
  }

  public async prepareDaemonForUnlock(): Promise<void> {
    this.ensureDesktop();
    await window.electronAPI!.prepareDaemonForUnlock();
  }

  public async submitDaemonPassword(password: string): Promise<string> {
    this.ensureDesktop();
    return window.electronAPI!.submitDaemonPassword(password);
  }

  public async hasAccounts(): Promise<boolean> {
    this.ensureDesktop();
    return window.electronAPI!.hasNoorSignerAccounts();
  }

  public static destroy(): void {
    KeySignerClient.instance = null;
  }
}
