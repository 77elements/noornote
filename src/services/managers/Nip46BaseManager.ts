/**
 * Nip46BaseManager
 * Base class for NIP-46 remote signer managers.
 *
 * Shared functionality:
 * - Event signing via remote signer
 * - NIP-44/NIP-04 encrypt/decrypt delegation
 * - RPC relay health checks and reconnection
 * - encryptionType lock (prevents NDK auto-flip to nip44)
 * - Session persistence and restore
 */

import { NDKNip46Signer, NDKUser } from '@nostr-dev-kit/ndk';

export const NIP46_STORAGE_KEY = 'noornote_nip46_payload';

// NDK relay status constants (mirrors NDKRelayStatus enum)
const RELAY_STATUS_CONNECTED = 5;

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

  /**
   * Ensure the RPC relay pool is connected before signing/encrypting.
   * Checks actual relay WebSocket status (not just cached pool stats)
   * and forces reconnection + re-subscription if needed.
   */
  /** Check if any relay in the pool is connected */
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

    if (this.hasConnectedRelay(pool)) return;

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
    } catch (err) {
      nip46Log.error('RPC relay reconnection failed:', err);
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
        nip46Log.error(`${operation} TIMEOUT after ${ms / 1000}s`);
        reject(new Error(`Remote signer ${operation} timeout after ${ms / 1000}s`));
      }, ms);

      promise.then(
        (result) => { clearTimeout(timeout); resolve(result); },
        (err) => { clearTimeout(timeout); reject(err); }
      );
    });
  }

  // ── Signer operations ──────────────────────────────────────────────

  public async signEvent(event: any): Promise<string> {
    if (!this.signer) {
      throw new Error('NIP-46 signer not available');
    }
    nip46Log.info('signEvent called');
    await this.ensureRpcRelayConnected();
    return this.withTimeout(this.signer.sign(event), 30000, 'sign_event');
  }

  public async nip44Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    if (!this.signer) throw new Error('NIP-46 signer not available');
    await this.ensureRpcRelayConnected();
    const recipient = new NDKUser({ pubkey: recipientPubkey });
    return this.withTimeout(this.signer.encrypt(recipient, plaintext, 'nip44'), 15000, 'nip44_encrypt');
  }

  public async nip44Decrypt(ciphertext: string, senderPubkey: string): Promise<string> {
    if (!this.signer) throw new Error('NIP-46 signer not available');
    await this.ensureRpcRelayConnected();
    const sender = new NDKUser({ pubkey: senderPubkey });
    return this.withTimeout(this.signer.decrypt(sender, ciphertext, 'nip44'), 15000, 'nip44_decrypt');
  }

  public async nip04Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    if (!this.signer) throw new Error('NIP-46 signer not available');
    await this.ensureRpcRelayConnected();
    const recipient = new NDKUser({ pubkey: recipientPubkey });
    return this.withTimeout(this.signer.encrypt(recipient, plaintext, 'nip04'), 15000, 'nip04_encrypt');
  }

  public async nip04Decrypt(ciphertext: string, senderPubkey: string): Promise<string> {
    if (!this.signer) throw new Error('NIP-46 signer not available');
    await this.ensureRpcRelayConnected();
    const sender = new NDKUser({ pubkey: senderPubkey });
    return this.withTimeout(this.signer.decrypt(sender, ciphertext, 'nip04'), 15000, 'nip04_decrypt');
  }

  // ── State ──────────────────────────────────────────────────────────

  public isAvailable(): boolean {
    return this.signer !== null;
  }

  public hasStoredSession(): boolean {
    return localStorage.getItem(NIP46_STORAGE_KEY) !== null;
  }

  // ── Session restore ────────────────────────────────────────────────

  public async restoreSession(): Promise<boolean> {
    const storedPayload = localStorage.getItem(NIP46_STORAGE_KEY);
    if (!storedPayload) return false;

    try {
      const { NostrTransport } = await import('../transport/NostrTransport');
      const ndk = NostrTransport.getInstance().getNDK();

      this.signer = await NDKNip46Signer.fromPayload(storedPayload, ndk);

      const secret = this.signer.secret;
      const bunkerPubkey = this.signer.bunkerPubkey;

      nip46Log.info('Restoring session, bunkerPubkey:', bunkerPubkey?.slice(0, 12) + '...');

      if (!this.signer.userPubkey && bunkerPubkey) {
        this.signer.userPubkey = bunkerPubkey;
      }

      this.lockEncryptionType(this.signer.rpc);
      this.activateRpcPool(this.signer.rpc);

      const localUser = await this.signer.localSigner.user();
      await this.signer.rpc.subscribe({
        kinds: [24133],
        '#p': [localUser.pubkey],
      });

      await new Promise<void>((resolve, reject) => {
        const timeoutMs = 15000;
        const timeout = setTimeout(() => {
          nip46Log.error('Session restore TIMEOUT after 15s');
          reject(new Error('Session restore timeout'));
        }, timeoutMs);

        const responseHandler = (response: any) => {
          nip46Log.info('Restore response:', {
            result: response?.result,
            error: response?.error,
          });

          if (response?.result === secret || response?.result === 'ack') {
            clearTimeout(timeout);
            nip46Log.info('Session restore confirmed');
            resolve();
          } else if (response?.error) {
            clearTimeout(timeout);
            reject(new Error(response.error));
          } else {
            nip46Log.warn('Unmatched restore response:', response?.result);
          }
        };

        this.signer!.rpc.on('response', responseHandler);

        this.signer!.rpc.sendRequest(
          bunkerPubkey!,
          'connect',
          [bunkerPubkey!, secret!],
          24133
        ).catch((err: any) => {
          nip46Log.error('Restore sendRequest error:', err);
        });
      });

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
