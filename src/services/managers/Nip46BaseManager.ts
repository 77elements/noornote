/**
 * Nip46BaseManager
 * Base class for NIP-46 remote signer managers.
 *
 * Shared functionality:
 * - Event signing via remote signer
 * - NIP-44/NIP-04 encrypt/decrypt delegation
 * - RPC relay health checks and reconnection
 * - Circuit breaker (prevents timeout floods when relay is down)
 * - encryptionType lock (prevents NDK auto-flip to nip44)
 * - Session persistence and restore
 */

import { NDKNip46Signer, NDKUser } from '@nostr-dev-kit/ndk';

export const NIP46_STORAGE_KEY = 'noornote_nip46_payload';

// NDK relay status constants (mirrors NDKRelayStatus enum)
const RELAY_STATUS_CONNECTED = 5;

// Circuit breaker: reject immediately instead of waiting for timeouts
const CIRCUIT_COOLDOWN_MS = 30_000;

// Debug logger for NIP-46
export const nip46Log = {
  info: (msg: string, ...args: any[]) => console.log(`[NIP-46] ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[NIP-46] ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[NIP-46] ${msg}`, ...args),
};

export interface Nip46AuthResult {
  success: boolean;
  npub?: string;
  pubkey?: string;
  error?: string;
}

export interface NostrConnectSession {
  uri: string;
  waitForConnection: () => Promise<Nip46AuthResult>;
  cancel: () => void;
}

export abstract class Nip46BaseManager {
  protected signer: NDKNip46Signer | null = null;

  // Circuit breaker state
  private circuitOpen = false;
  private circuitOpenSince = 0;

  /**
   * Lock encryptionType to 'nip04' using Object.defineProperty.
   * NDK's parseEvent auto-detects encryption type on every incoming event
   * and can flip it to 'nip44', which breaks sendRequest for signers
   * that only support NIP-04 on the RPC layer. This lock prevents that.
   */
  protected lockEncryptionType(rpc: any): void {
    let _encType: 'nip04' | 'nip44' = 'nip04';
    Object.defineProperty(rpc, 'encryptionType', {
      get: () => _encType,
      set: (val: string) => {
        if (val !== _encType) {
          nip46Log.warn(`Blocked encryptionType change from "${_encType}" to "${val}"`);
        }
      },
      configurable: true,
      enumerable: true,
    });
    nip46Log.info('encryptionType locked to nip04');
  }

  /**
   * Fully stop a signer and disconnect its RPC relay pool.
   * NDKNip46Signer.stop() only stops the subscription —
   * the RPC pool stays alive with open WebSocket connections.
   */
  protected stopSignerAndPool(signer: NDKNip46Signer): void {
    signer.stop();
    const rpc = signer.rpc as any;
    if (rpc.pool) {
      for (const relay of rpc.pool.relays.values()) {
        relay.disconnect();
      }
    }
  }

  /**
   * Activate the RPC relay pool so NDK's auto-reconnection logic works.
   * NDK's RPC constructor connects relays individually but never calls
   * pool.connect(), leaving the pool in "idle" state where system-wide
   * reconnection is disabled.
   */
  protected activateRpcPool(rpc: any): void {
    const pool = rpc.pool;
    if (!pool) return;
    pool.connect().catch(() => {
      // Swallow — ensureRpcRelayConnected() will retry before any operation.
    });
  }

  // ── Circuit breaker ────────────────────────────────────────────────

  /**
   * Check circuit breaker before any RPC operation.
   * If relay was recently unreachable, reject immediately instead of
   * waiting 15-30s for another timeout.
   */
  private checkCircuitBreaker(): void {
    if (!this.circuitOpen) return;

    const elapsed = Date.now() - this.circuitOpenSince;
    if (elapsed < CIRCUIT_COOLDOWN_MS) {
      const remaining = Math.ceil((CIRCUIT_COOLDOWN_MS - elapsed) / 1000);
      throw new Error(`Remote signer unreachable — retrying in ${remaining}s`);
    }

    // Cooldown elapsed — allow retry
    nip46Log.info('Circuit breaker cooldown elapsed, allowing retry');
    this.circuitOpen = false;
  }

  private openCircuit(): void {
    if (!this.circuitOpen) {
      nip46Log.warn(`Remote signer unreachable — suppressing further requests for ${CIRCUIT_COOLDOWN_MS / 1000}s`);
    }
    this.circuitOpen = true;
    this.circuitOpenSince = Date.now();
  }

  private closeCircuit(): void {
    if (this.circuitOpen) {
      nip46Log.info('Remote signer reconnected — circuit breaker reset');
    }
    this.circuitOpen = false;
  }

  // ── Relay health ───────────────────────────────────────────────────

  private hasConnectedRelay(pool: any): boolean {
    for (const relay of pool.relays.values()) {
      if (relay.status >= RELAY_STATUS_CONNECTED) return true;
    }
    return false;
  }

  private async ensureRpcRelayConnected(): Promise<void> {
    if (!this.signer) return;

    const rpc = this.signer.rpc as any;
    const pool = rpc.pool;
    if (!pool) return;

    if (this.hasConnectedRelay(pool)) {
      this.closeCircuit();
      return;
    }

    nip46Log.warn('RPC relay disconnected, reconnecting...');
    try {
      await pool.connect(5000);

      if (!this.hasConnectedRelay(pool)) {
        throw new Error('No relay connected after timeout');
      }

      const localUser = await this.signer!.localSigner.user();
      await rpc.subscribe({
        kinds: [24133],
        '#p': [localUser.pubkey],
      });

      nip46Log.info('RPC relay reconnected and re-subscribed');
      this.closeCircuit();
    } catch (err) {
      this.openCircuit();
      throw new Error('Remote signer relay is not reachable');
    }
  }

  /**
   * Wrap an RPC operation with a timeout.
   * NDK's sign/encrypt promises hang forever if no response arrives.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.openCircuit();
        nip46Log.error(`${operation} TIMEOUT after ${ms / 1000}s`);
        reject(new Error(`Remote signer ${operation} timeout after ${ms / 1000}s`));
      }, ms);

      promise.then(
        (result) => { clearTimeout(timeout); this.closeCircuit(); resolve(result); },
        (err) => { clearTimeout(timeout); reject(err); }
      );
    });
  }

  // ── Signer operations ──────────────────────────────────────────────

  /**
   * Ensure the signer is available, circuit breaker allows requests,
   * and at least one RPC relay is connected. Returns the verified signer.
   */
  private async guardRpcReady(): Promise<NDKNip46Signer> {
    if (!this.signer) throw new Error('NIP-46 signer not available');
    this.checkCircuitBreaker();
    await this.ensureRpcRelayConnected();
    return this.signer;
  }

  private async encryptOrDecrypt(
    pubkey: string,
    text: string,
    method: 'encrypt' | 'decrypt',
    scheme: 'nip04' | 'nip44',
  ): Promise<string> {
    const signer = await this.guardRpcReady();
    const user = new NDKUser({ pubkey });
    const operation = `${scheme}_${method}`;
    return this.withTimeout(signer[method](user, text, scheme), 15000, operation);
  }

  public async signEvent(event: any): Promise<string> {
    const signer = await this.guardRpcReady();
    return this.withTimeout(signer.sign(event), 30000, 'sign_event');
  }

  public async nip44Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    return this.encryptOrDecrypt(recipientPubkey, plaintext, 'encrypt', 'nip44');
  }

  public async nip44Decrypt(ciphertext: string, senderPubkey: string): Promise<string> {
    return this.encryptOrDecrypt(senderPubkey, ciphertext, 'decrypt', 'nip44');
  }

  public async nip04Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    return this.encryptOrDecrypt(recipientPubkey, plaintext, 'encrypt', 'nip04');
  }

  public async nip04Decrypt(ciphertext: string, senderPubkey: string): Promise<string> {
    return this.encryptOrDecrypt(senderPubkey, ciphertext, 'decrypt', 'nip04');
  }

  // ── State ──────────────────────────────────────────────────────────

  public isAvailable(): boolean {
    return this.signer !== null;
  }

  public hasStoredSession(): boolean {
    return localStorage.getItem(NIP46_STORAGE_KEY) !== null;
  }

  // ── Connect handshake ─────────────────────────────────────────────

  /**
   * Subscribe to RPC responses, send a 'connect' request, and wait
   * for the remote signer to confirm (result === secret or 'ack').
   * Shared by restoreSession() and BunkerSignerManager.authenticate().
   */
  protected async subscribeAndConnect(timeoutMs: number, label: string): Promise<void> {
    const signer = this.signer!;
    const secret = signer.secret;
    const bunkerPubkey = signer.bunkerPubkey!;

    const localUser = await signer.localSigner.user();
    await signer.rpc.subscribe({
      kinds: [24133],
      '#p': [localUser.pubkey],
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        nip46Log.error(`${label} TIMEOUT after ${timeoutMs / 1000}s`);
        reject(new Error(`${label} timeout after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      signer.rpc.on('response', (response: any) => {
        nip46Log.info(`${label} response:`, {
          result: response?.result,
          error: response?.error,
        });

        if (response?.result === secret || response?.result === 'ack') {
          clearTimeout(timeout);
          nip46Log.info(`${label} confirmed`);
          resolve();
        } else if (response?.error) {
          clearTimeout(timeout);
          reject(new Error(response.error));
        } else {
          nip46Log.warn(`${label} unmatched response:`, response?.result);
        }
      });

      signer.rpc.sendRequest(
        bunkerPubkey,
        'connect',
        [bunkerPubkey, secret!],
        24133
      ).catch((err: any) => {
        nip46Log.error(`${label} sendRequest error:`, err);
      });
    });
  }

  // ── Session restore ────────────────────────────────────────────────

  public async restoreSession(): Promise<boolean> {
    const storedPayload = localStorage.getItem(NIP46_STORAGE_KEY);
    if (!storedPayload) return false;

    try {
      const { NostrTransport } = await import('../transport/NostrTransport');
      const ndk = NostrTransport.getInstance().getNDK();

      this.signer = await NDKNip46Signer.fromPayload(storedPayload, ndk);

      const bunkerPubkey = this.signer.bunkerPubkey;
      nip46Log.info('Restoring session, bunkerPubkey:', bunkerPubkey?.slice(0, 12) + '...');

      if (!this.signer.userPubkey && bunkerPubkey) {
        this.signer.userPubkey = bunkerPubkey;
      }

      this.lockEncryptionType(this.signer.rpc);
      this.activateRpcPool(this.signer.rpc);

      await this.subscribeAndConnect(15000, 'Session restore');

      nip46Log.info('Session restored successfully');
      return true;
    } catch (err) {
      nip46Log.error('Session restore failed:', err);
      localStorage.removeItem(NIP46_STORAGE_KEY);
      this.signer = null;
      return false;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  public cleanup(): void {
    this.stop();
    localStorage.removeItem(NIP46_STORAGE_KEY);
  }

  public stop(): void {
    if (this.signer) {
      this.stopSignerAndPool(this.signer);
      this.signer = null;
    }
  }
}
