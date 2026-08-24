/**
 * NWCService - Nostr Wallet Connect Service
 * Handles NWC connection and Lightning invoice payments (NIP-47)
 *
 * Architecture: Per-user state via Maps (no clearing/overwriting on account switch)
 * - connections: Map<pubkey, NWCConnection>
 * - states: Map<pubkey, NWCConnectionState>
 *
 * IMPORTANT: Uses direct WebSocket connections instead of NDK relay pool
 * to avoid connection issues when switching between accounts.
 *
 * NIP-47: https://github.com/nostr-protocol/nips/blob/master/47.md
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import {
  decodeNip19,
  nip04,
  finalizeEvent,
  getPublicKeyFromPrivate,
  hexToBytes,
} from './NostrToolsAdapter';
import { SystemLogger } from './SystemLogger';
import { ErrorService } from './ErrorService';
import { ToastService } from './ToastService';
import { KeychainStorage } from './KeychainStorage';
import { AuthService } from './AuthService';
import { TypedEventBus } from '../core/TypedEventBus';
import { SignatureVerificationService } from './security/SignatureVerificationService';

export type NWCConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export interface NWCConnection {
  walletPubkey: string;
  relay: string;
  secret: string;
  lud16?: string; // Optional Lightning Address (e.g., user@getalby.com)
}

export interface PayInvoiceResult {
  success: boolean;
  preimage?: string;
  error?: string;
}

export interface NWCTransaction {
  type: 'incoming' | 'outgoing';
  invoice?: string;
  payment_hash: string;
  preimage?: string;
  /** Amount in millisatoshis */
  amount: number;
  /** Fees paid in millisatoshis */
  fees_paid?: number;
  /** Unix timestamp */
  created_at: number;
  /** Unix timestamp (null if pending) */
  settled_at?: number;
  description?: string;
}

export interface ListTransactionsParams {
  from?: number;
  until?: number;
  limit?: number;
  offset?: number;
  type?: 'incoming' | 'outgoing';
}

export class NWCService {
  private static instance: NWCService;
  private systemLogger: SystemLogger;

  // Per-user state - NO clearing needed on account switch
  private connections: Map<string, NWCConnection> = new Map();
  private states: Map<string, NWCConnectionState> = new Map();

  private constructor() {
    this.systemLogger = SystemLogger.getInstance();

    // Listen for user login to restore NWC connection
    TypedEventBus.getInstance().on('user:login', () => {
      void this.restoreConnectionForCurrentUser();
    });

    // Try to restore connection for current user (if already logged in)
    void this.restoreConnectionForCurrentUser();
  }

  public static getInstance(): NWCService {
    if (!NWCService.instance) {
      NWCService.instance = new NWCService();
    }
    return NWCService.instance;
  }

  /**
   * Get current user's pubkey
   */
  private getCurrentUserPubkey(): string | null {
    const user = AuthService.getInstance().getCurrentUser();
    return user?.pubkey || null;
  }

  /**
   * Get connection for current user
   */
  private getConnectionForCurrentUser(): NWCConnection | null {
    const pubkey = this.getCurrentUserPubkey();
    if (!pubkey) return null;
    return this.connections.get(pubkey) || null;
  }

  /**
   * Get state for current user
   */
  private getStateForCurrentUser(): NWCConnectionState {
    const pubkey = this.getCurrentUserPubkey();
    if (!pubkey) return 'disconnected';
    return this.states.get(pubkey) || 'disconnected';
  }

  /**
   * Set connection for current user
   */
  private setConnectionForCurrentUser(connection: NWCConnection | null): void {
    const pubkey = this.getCurrentUserPubkey();
    if (!pubkey) return;

    if (connection) {
      this.connections.set(pubkey, connection);
    } else {
      this.connections.delete(pubkey);
    }
  }

  /**
   * Set state for current user
   */
  private setStateForCurrentUser(state: NWCConnectionState): void {
    const pubkey = this.getCurrentUserPubkey();
    if (!pubkey) return;
    this.states.set(pubkey, state);
  }

  /**
   * Parse NWC connection string
   * Format: nostr+walletconnect://<wallet-pubkey>?relay=<relay-url>&secret=<secret-hex>&lud16=<lightning-address>
   */
  private parseConnectionString(connectionString: string): NWCConnection {
    try {
      const url = new URL(connectionString);

      // Extract pubkey from pathname or host (some formats use host, some use pathname)
      let walletPubkey = url.pathname || url.host;

      // Remove leading slash if present
      if (walletPubkey.startsWith('/')) {
        walletPubkey = walletPubkey.substring(1);
      }

      // Decode npub to hex if needed
      if (walletPubkey.startsWith('npub')) {
        const decoded = decodeNip19(walletPubkey);
        if (decoded.type === 'npub') {
          walletPubkey = decoded.data as string;
        }
      }

      const relay = url.searchParams.get('relay');
      const secret = url.searchParams.get('secret');
      const lud16 = url.searchParams.get('lud16'); // Optional Lightning Address

      if (!walletPubkey || !relay || !secret) {
        throw new Error(
          'Missing required parameters (pubkey, relay, or secret)'
        );
      }

      const connection: NWCConnection = { walletPubkey, relay, secret };
      if (lud16) {
        connection.lud16 = lud16; // URL.searchParams.get() auto-decodes %40 to @
      }
      return connection;
    } catch (_error) {
      this.systemLogger.error(
        'NWCService',
        'Failed to parse connection string:',
        _error
      );
      throw new Error('Invalid NWC connection string format');
    }
  }

  /**
   * Connect to NWC relay via direct WebSocket (bypasses NDK relay pool)
   * This avoids issues when switching between accounts using the same relay
   */
  private connectToNwcRelay(
    url: string,
    timeoutMs: number = 5000
  ): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`WebSocket connection timeout: ${url}`));
      }, timeoutMs);

      ws.onopen = () => {
        clearTimeout(timeout);
        resolve(ws);
      };

      ws.onerror = error => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket connection error: ${error}`));
      };
    });
  }

  /**
   * Send NWC request via WebSocket and wait for response
   * @param ws WebSocket connection
   * @param event Signed NWC request event (kind 23194)
   * @param expectedAuthor Expected author of the response (wallet pubkey)
   * @param expectedPTag Expected p-tag in response (app pubkey)
   * @param timeoutMs Timeout in milliseconds
   */
  private sendNwcRequest(
    ws: WebSocket,
    event: NostrEvent,
    expectedAuthor: string,
    expectedPTag: string,
    timeoutMs: number = 10000
  ): Promise<NostrEvent> {
    return new Promise((resolve, reject) => {
      const subId = `nwc-${Date.now()}`;

      const timeout = setTimeout(() => {
        ws.send(JSON.stringify(['CLOSE', subId]));
        reject(new Error('NWC request timeout'));
      }, timeoutMs);

      const handleMessage = (msgEvent: MessageEvent) => {
        try {
          const data = JSON.parse(msgEvent.data);

          // Handle EVENT messages
          if (data[0] === 'EVENT' && data[1] === subId && data[2]) {
            const responseEvent = data[2] as NostrEvent;

            // Verify it's a response event (kind 23195) from the expected author
            if (
              responseEvent.kind === 23195 &&
              responseEvent.pubkey === expectedAuthor &&
              responseEvent.tags.some(
                (t: string[]) => t[0] === 'p' && t[1] === expectedPTag
              )
            ) {
              // Verify signature before trusting NWC response (external WebSocket event)
              const verification =
                SignatureVerificationService.getInstance().verifyEvent(
                  responseEvent
                );
              if (!verification.valid) {
                clearTimeout(timeout);
                ws.removeEventListener('message', handleMessage);
                ws.send(JSON.stringify(['CLOSE', subId]));
                reject(new Error('NWC response failed signature verification'));
                return;
              }
              clearTimeout(timeout);
              ws.removeEventListener('message', handleMessage);
              ws.send(JSON.stringify(['CLOSE', subId]));
              resolve(responseEvent);
            }
          }

          // Handle OK message (event published successfully)
          if (data[0] === 'OK' && data[1] === event.id) {
            // Event accepted, continue waiting for response
          }

          // Handle EOSE (end of stored events)
          if (data[0] === 'EOSE' && data[1] === subId) {
            // Continue waiting for new events
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.addEventListener('message', handleMessage);

      // Subscribe to response events, filtered by request event ID (#e tag)
      // to avoid mixing up responses when multiple requests run in parallel.
      const filter = {
        kinds: [23195],
        authors: [expectedAuthor],
        '#p': [expectedPTag],
        '#e': [event.id],
        since: Math.floor(Date.now() / 1000) - 5, // 5 seconds buffer
      };
      ws.send(JSON.stringify(['REQ', subId, filter]));

      // Publish the request event
      ws.send(JSON.stringify(['EVENT', event]));
    });
  }

  /**
   * Connect to NWC wallet
   */
  public async connect(connectionString: string): Promise<boolean> {
    this.setStateForCurrentUser('connecting');

    try {
      // Parse connection string
      const connection = this.parseConnectionString(connectionString);

      // Test connection by sending info request
      const isValid = await this.testConnection(connection);

      if (!isValid) {
        this.setStateForCurrentUser('error');
        ToastService.show('Wallet connection failed', 'error');
        return false;
      }

      // Store connection in memory
      this.setConnectionForCurrentUser(connection);
      this.setStateForCurrentUser('connected');

      // Persist to KeychainStorage (secure, per-user)
      await this.saveConnection(connectionString);

      this.systemLogger.info(
        'NWCService',
        'Connected to NWC wallet:',
        connection.walletPubkey.slice(0, 8)
      );
      ToastService.show('Lightning Wallet connected', 'success');

      return true;
    } catch (_error) {
      this.setStateForCurrentUser('error');
      ErrorService.handle(
        _error,
        'NWCService.connect',
        true,
        'NWC connection failed. Please check the connection string.'
      );
      return false;
    }
  }

  /**
   * Execute NWC request with WebSocket connection management
   * Centralizes: connect, encrypt, sign, send, decrypt flow
   */
  private async executeNwcRequest<T>(
    connection: NWCConnection,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = 10000
  ): Promise<{ result?: T; error?: { message: string } }> {
    let ws: WebSocket | null = null;

    try {
      ws = await this.connectToNwcRelay(connection.relay);

      const content = JSON.stringify({ method, params });
      const appSecretKey = hexToBytes(connection.secret);
      const appPubkey = getPublicKeyFromPrivate(connection.secret);
      const encryptedContent = nip04.encrypt(
        connection.secret,
        connection.walletPubkey,
        content
      );

      const event = finalizeEvent(
        {
          kind: 23194,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', connection.walletPubkey]],
          content: encryptedContent,
        },
        appSecretKey
      );

      const response = await this.sendNwcRequest(
        ws,
        event,
        connection.walletPubkey,
        appPubkey,
        timeoutMs
      );
      const decrypted = nip04.decrypt(
        connection.secret,
        connection.walletPubkey,
        response.content
      );

      return JSON.parse(decrypted);
    } finally {
      ws?.close();
    }
  }

  /**
   * Test NWC connection by sending get_info request
   */
  private async testConnection(connection: NWCConnection): Promise<boolean> {
    try {
      const response = await this.executeNwcRequest(
        connection,
        'get_info',
        {},
        5000
      );
      return !!response.result;
    } catch (error) {
      this.systemLogger.error('NWCService', 'Test connection failed:', error);
      return false;
    }
  }

  /**
   * Disconnect from NWC wallet
   * CRITICAL: This is the ONLY method that may delete the stored connection
   */
  public async disconnect(): Promise<void> {
    this.systemLogger.warn(
      'NWCService',
      '⚠️ DISCONNECT called - removing stored NWC connection'
    );

    this.setConnectionForCurrentUser(null);
    this.setStateForCurrentUser('disconnected');

    // Delete from both storage locations (one will fail, that's ok)
    try {
      const pubkey = this.getCurrentUserPubkey();
      if (pubkey) {
        // Try encrypted file (Desktop only)
        const { PlatformService } = await import('./PlatformService');
        if (PlatformService.getInstance().isDesktop) {
          const { EncryptedFileStorage } = await import(
            './EncryptedFileStorage'
          );
          await EncryptedFileStorage.deleteNWC(pubkey);
        }
      }

      // Try keychain (always)
      await KeychainStorage.deleteNWC();

      this.systemLogger.info(
        'NWCService',
        '✓ Stored NWC connection removed from secure storage'
      );
    } catch (_error) {
      this.systemLogger.error(
        'NWCService',
        'Failed to remove stored connection:',
        _error
      );
    }

    this.systemLogger.info('NWCService', 'Disconnected from NWC wallet');
    ToastService.show('Lightning Wallet disconnected', 'info');
  }

  /**
   * Check if connected to NWC wallet
   * Returns true if connection exists for current user
   */
  public isConnected(): boolean {
    return this.getConnectionForCurrentUser() !== null;
  }

  /**
   * Get current connection state
   */
  public getState(): NWCConnectionState {
    return this.getStateForCurrentUser();
  }

  /**
   * Get wallet pubkey (if connected)
   */
  public getWalletPubkey(): string | null {
    return this.getConnectionForCurrentUser()?.walletPubkey || null;
  }

  /**
   * Get Lightning Address (lud16) from NWC connection (if available)
   */
  public getLightningAddress(): string | null {
    return this.getConnectionForCurrentUser()?.lud16 || null;
  }

  /**
   * Get wallet info including supported methods (NIP-47 get_info)
   */
  public async getInfo(): Promise<Record<string, unknown> | null> {
    const connection = this.getConnectionForCurrentUser();
    if (!connection) return null;
    try {
      const response = await this.executeNwcRequest<Record<string, unknown>>(
        connection,
        'get_info'
      );
      return response.result ?? null;
    } catch {
      return null;
    }
  }

  /**
   * List wallet transactions (NIP-47 list_transactions)
   */
  public async listTransactions(
    params: ListTransactionsParams = {}
  ): Promise<NWCTransaction[]> {
    const connection = this.getConnectionForCurrentUser();
    if (!connection) return [];

    try {
      const response = await this.executeNwcRequest<{
        transactions: NWCTransaction[];
      }>(
        connection,
        'list_transactions',
        params as Record<string, unknown>,
        15000
      );
      if (response.error) {
        this.systemLogger.error(
          'NWCService',
          'List transactions failed:',
          response.error.message
        );
        return [];
      }

      return response.result?.transactions ?? [];
    } catch (error) {
      this.systemLogger.error('NWCService', 'List transactions failed:', error);
      return [];
    }
  }

  /**
   * Get wallet balance via NWC (returns millisatoshis)
   */
  public async getBalance(): Promise<number | null> {
    const connection = this.getConnectionForCurrentUser();
    if (!connection) return null;

    try {
      const response = await this.executeNwcRequest<{ balance: number }>(
        connection,
        'get_balance'
      );

      if (response.error) {
        this.systemLogger.error(
          'NWCService',
          'Get balance failed:',
          response.error.message
        );
        return null;
      }

      return response.result?.balance ?? null;
    } catch (error) {
      this.systemLogger.error('NWCService', 'Get balance failed:', error);
      return null;
    }
  }

  /**
   * Pay Lightning invoice via NWC
   */
  public async payInvoice(invoice: string): Promise<PayInvoiceResult> {
    const connection = this.getConnectionForCurrentUser();
    if (!connection) {
      return { success: false, error: 'Not connected to NWC wallet' };
    }

    try {
      this.systemLogger.info('NWCService', 'Sending pay_invoice request...');

      const response = await this.executeNwcRequest<{
        preimage: string;
        amount?: number;
        fees_paid?: number;
      }>(
        connection,
        'pay_invoice',
        { invoice },
        30000 // 30s timeout for payments
      );

      if (response.error) {
        this.systemLogger.error(
          'NWCService',
          'Payment failed:',
          response.error.message
        );
        return {
          success: false,
          error: response.error.message || 'Payment failed',
        };
      }

      if (response.result) {
        const amount = response.result.amount
          ? Math.floor(response.result.amount / 1000)
          : 0;
        const fees = response.result.fees_paid
          ? Math.floor(response.result.fees_paid / 1000)
          : 0;
        this.systemLogger.info(
          'NWCService',
          `${amount} Sats sent, ${fees} Sats fees paid`
        );

        return { success: true, preimage: response.result.preimage };
      }

      return { success: false, error: 'Invalid response' };
    } catch (error) {
      this.systemLogger.error('NWCService', 'Payment failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Check if encrypted file storage should be used
   */
  private async shouldUseEncryptedFile(): Promise<boolean> {
    const { PlatformService } = await import('./PlatformService');
    return PlatformService.getInstance().isDesktop;
  }

  /**
   * Save connection to KeychainStorage or EncryptedFile (per-user)
   */
  private async saveConnection(connectionString: string): Promise<void> {
    try {
      if (await this.shouldUseEncryptedFile()) {
        const { EncryptedFileStorage } = await import('./EncryptedFileStorage');
        const pubkey = this.getCurrentUserPubkey();
        if (pubkey) {
          await EncryptedFileStorage.saveNWC(connectionString, pubkey);
          this.systemLogger.info(
            'NWCService',
            'NWC connection saved to encrypted file'
          );
        }
      } else {
        await KeychainStorage.saveNWC(connectionString);
        this.systemLogger.info(
          'NWCService',
          'NWC connection saved to secure storage'
        );
      }
    } catch (error) {
      this.systemLogger.error(
        'NWCService',
        'Failed to save connection:',
        error
      );
      throw error;
    }
  }

  /**
   * Restore connection for current user from KeychainStorage or EncryptedFile
   * Called on init and can be called when user changes
   */
  public async restoreConnectionForCurrentUser(): Promise<void> {
    const pubkey = this.getCurrentUserPubkey();
    if (!pubkey) return;

    // Already loaded for this user?
    if (this.connections.has(pubkey)) return;

    try {
      let stored: string | null = null;

      if (await this.shouldUseEncryptedFile()) {
        const { EncryptedFileStorage } = await import('./EncryptedFileStorage');
        stored = await EncryptedFileStorage.loadNWC(pubkey);
      } else {
        stored = await KeychainStorage.loadNWC(pubkey);
      }

      if (!stored) return;

      this.systemLogger.info(
        'NWCService',
        'Found stored connection, attempting to reconnect...'
      );

      const connection = this.parseConnectionString(stored);
      this.connections.set(pubkey, connection);

      const isValid = await this.testConnection(connection);

      if (isValid) {
        this.states.set(pubkey, 'connected');
        this.systemLogger.info('NWCService', 'Auto-reconnected to NWC wallet');
        window.dispatchEvent(new CustomEvent('nwc-connection-restored'));
      } else {
        this.states.set(pubkey, 'error');
        this.systemLogger.warn(
          'NWCService',
          'Failed to auto-reconnect (relay offline?), but connection kept.'
        );
      }
    } catch (error) {
      this.systemLogger.error(
        'NWCService',
        'Failed to restore connection:',
        error
      );
    }
  }
}
