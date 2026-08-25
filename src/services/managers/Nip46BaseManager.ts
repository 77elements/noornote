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

import {
  NDKNip46Signer,
  NDKUser,
  type NostrEvent,
  type NDKRpcResponse,
} from '@nostr-dev-kit/ndk';
import { SystemLogger } from '../SystemLogger';
import type { SignableEvent } from '../AuthService';

export const NIP46_STORAGE_KEY = 'noornote_nip46_payload';

// NDK relay status constants (mirrors NDKRelayStatus enum)
const RELAY_STATUS_CONNECTED = 5;

// Circuit breaker: reject immediately instead of waiting for timeouts
const CIRCUIT_COOLDOWN_MS = 30_000;

// Technical debug logger (DevTools console only)
export const nip46Log = {
  info: (msg: string, ...args: unknown[]) =>
    console.debug(`[NIP-46] ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) =>
    console.debug(`[NIP-46] ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) =>
    console.error(`[NIP-46] ${msg}`, ...args),
};

// User-facing System Log
const sysLog = () => SystemLogger.getInstance();

/**
 * Structural view of NDKNostrRpc's PRIVATE internals (pool/relays). NDK
 * declares `pool` as private and offers no API for pool-level health checks
 * or disconnects, so we reach in deliberately — typed here so every access
 * is visible and reviewed instead of hidden behind `as any`.
 */
interface Nip46RpcInternals {
  subscribe(filter: { kinds: number[]; '#p': string[] }): Promise<unknown>;
  pool?: {
    relays: Map<string, { status: number; disconnect(): void }>;
    connect(timeoutMs?: number): Promise<void>;
  };
  encryptionType: 'nip04' | 'nip44';
}

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

  // NIP-46 session state: connect handshake completed?
  private sessionEstablished = false;

  // Circuit breaker state
  private circuitOpen = false;
  private circuitOpenSince = 0;

  /**
   * Lock encryptionType to 'nip04' using Object.defineProperty.
   * NDK's parseEvent auto-detects encryption type on every incoming event
   * and can flip it to 'nip44', which breaks sendRequest for signers
   * that only support NIP-04 on the RPC layer. This lock prevents that.
   */
  protected lockEncryptionType(signer: NDKNip46Signer): void {
    const rpc = signer.rpc as unknown as Nip46RpcInternals;
    const _encType: 'nip04' | 'nip44' = 'nip04';
    Object.defineProperty(rpc, 'encryptionType', {
      get: () => _encType,
      set: (val: 'nip04' | 'nip44') => {
        if (val !== _encType) {
          nip46Log.info(
            `Encryption locked to ${_encType} — rejected ${val} upgrade`
          );
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
    this.sessionEstablished = false;
    const rpc = signer.rpc as unknown as Nip46RpcInternals;
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
  protected activateRpcPool(signer: NDKNip46Signer): void {
    const rpc = signer.rpc as unknown as Nip46RpcInternals;
    const pool = rpc.pool;
    if (!pool) return;
    void pool.connect().catch(() => {
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
      nip46Log.warn(
        `Remote signer unreachable — suppressing further requests for ${CIRCUIT_COOLDOWN_MS / 1000}s`
      );
      sysLog().warn('Auth', 'Remote signer unreachable — retrying shortly');
    }
    this.circuitOpen = true;
    this.circuitOpenSince = Date.now();
  }

  private closeCircuit(): void {
    if (this.circuitOpen) {
      nip46Log.info('Remote signer reconnected — circuit breaker reset');
      sysLog().success('Auth', 'Remote signer reconnected');
    }
    this.circuitOpen = false;
  }

  // ── Relay health ───────────────────────────────────────────────────

  private hasConnectedRelay(
    pool: NonNullable<Nip46RpcInternals['pool']>
  ): boolean {
    for (const relay of pool.relays.values()) {
      if (relay.status >= RELAY_STATUS_CONNECTED) return true;
    }
    return false;
  }

  private async ensureRpcRelayConnected(): Promise<void> {
    if (!this.signer) return;

    const rpc = this.signer.rpc as unknown as Nip46RpcInternals;
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

      // Relay reconnected, but NIP-46 session needs re-establishment
      this.sessionEstablished = false;
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
  private withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    operation: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.openCircuit();
        nip46Log.error(`${operation} TIMEOUT after ${ms / 1000}s`);
        reject(
          new Error(`Remote signer ${operation} timeout after ${ms / 1000}s`)
        );
      }, ms);

      promise.then(
        result => {
          clearTimeout(timeout);
          this.closeCircuit();
          resolve(result);
        },
        err => {
          clearTimeout(timeout);
          reject(err);
        }
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

    // Lazy connect: if the NIP-46 handshake wasn't completed at startup
    // (remote signer was offline), attempt it now before any sign/encrypt.
    if (!this.sessionEstablished) {
      nip46Log.info(
        'NIP-46 session not established, attempting connect handshake...'
      );
      try {
        await this.subscribeAndConnect(15000, 'Lazy connect');
        this.sessionEstablished = true;
        sysLog().success('Auth', 'Remote signer connected');
      } catch (err) {
        this.openCircuit();
        throw new Error(
          'Remote signer not responding — please check that it is running'
        );
      }
    }

    return this.signer;
  }

  private async encryptOrDecrypt(
    pubkey: string,
    text: string,
    method: 'encrypt' | 'decrypt',
    scheme: 'nip04' | 'nip44'
  ): Promise<string> {
    const signer = await this.guardRpcReady();
    const user = new NDKUser({ pubkey });
    const operation = `${scheme}_${method}`;
    return this.withTimeout(
      signer[method](user, text, scheme),
      15000,
      operation
    );
  }

  public async signEvent(event: SignableEvent): Promise<string> {
    const signer = await this.guardRpcReady();
    // Drafts from AuthService always carry pubkey/created_at by now; default
    // tags so the serialized event is well-formed for the remote signer.
    const complete = {
      ...event,
      tags: event.tags ?? [],
      created_at: event.created_at ?? Math.floor(Date.now() / 1000),
      pubkey: event.pubkey ?? '',
    } as NostrEvent;
    return this.withTimeout(signer.sign(complete), 30000, 'sign_event');
  }

  public async nip44Encrypt(
    plaintext: string,
    recipientPubkey: string
  ): Promise<string> {
    return this.encryptOrDecrypt(
      recipientPubkey,
      plaintext,
      'encrypt',
      'nip44'
    );
  }

  public async nip44Decrypt(
    ciphertext: string,
    senderPubkey: string
  ): Promise<string> {
    return this.encryptOrDecrypt(senderPubkey, ciphertext, 'decrypt', 'nip44');
  }

  public async nip04Encrypt(
    plaintext: string,
    recipientPubkey: string
  ): Promise<string> {
    return this.encryptOrDecrypt(
      recipientPubkey,
      plaintext,
      'encrypt',
      'nip04'
    );
  }

  public async nip04Decrypt(
    ciphertext: string,
    senderPubkey: string
  ): Promise<string> {
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
  protected async subscribeAndConnect(
    timeoutMs: number,
    label: string
  ): Promise<void> {
    const signer = this.signer!;
    const secret = signer.secret;
    const bunkerPubkey = signer.bunkerPubkey!;

    const localUser = await signer.localSigner.user();
    await signer.rpc.subscribe({
      kinds: [24133],
      '#p': [localUser.pubkey],
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        nip46Log.error(`${label} TIMEOUT after ${timeoutMs / 1000}s`);
        reject(new Error(`${label} timeout after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      signer.rpc.on('response', (response: NDKRpcResponse) => {
        if (settled) return;

        if (response?.result === secret || response?.result === 'ack') {
          settled = true;
          clearTimeout(timeout);
          nip46Log.info(`${label} confirmed`);
          resolve();
        } else if (response?.error) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(response.error));
        }
      });

      signer.rpc
        .sendRequest(bunkerPubkey, 'connect', [bunkerPubkey, secret!], 24133)
        .catch((err: unknown) => {
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
      nip46Log.info(
        'Restoring session, bunkerPubkey:',
        `${bunkerPubkey?.slice(0, 12)}...`
      );

      if (!this.signer.userPubkey && bunkerPubkey) {
        this.signer.userPubkey = bunkerPubkey;
      }

      this.lockEncryptionType(this.signer);
      this.activateRpcPool(this.signer);

      // Lazy connect: try handshake but keep signer alive if remote signer is offline.
      // guardRpcReady() will reconnect before the first actual sign/encrypt operation.
      try {
        await this.subscribeAndConnect(15000, 'Session restore');
        this.sessionEstablished = true;
        nip46Log.info('Session restored successfully');
        sysLog().success('Auth', 'Remote signer session restored');
      } catch (connectErr) {
        // Signer stays alive, guardRpcReady() will retry the connect handshake on demand
        nip46Log.warn(
          'Remote signer offline at startup, will reconnect on demand:',
          connectErr
        );
        sysLog().warn(
          'Auth',
          'Remote signer offline — will reconnect when needed'
        );
      }

      return true;
    } catch (err) {
      // Signer creation failed (corrupted payload) — clean up
      nip46Log.error('Session restore failed:', err);
      sysLog().error(
        'Auth',
        'Remote signer session expired — please reconnect'
      );
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
