/**
 * Keychain Storage Service
 * Secure storage for sensitive data (NWC connection strings)
 * Uses IndexedDB for browser/web storage.
 * Desktop (Electron) uses EncryptedFileStorage for NWC, not this service.
 *
 * Encryption: NWC connection strings are encrypted via NWCCryptoService
 * (AES-256-GCM with a device-bound random key) before being written to
 * IndexedDB. Legacy plaintext blobs from older versions are silently
 * migrated to the new v2 format on load. See docs/todos/nwc-encryption.md.
 *
 * IndexedDB is used instead of localStorage because:
 * - Not synchronously accessible via JS (harder to exploit via XSS)
 * - Isolated per origin
 * - Still not fully secure in browser - use desktop app for best security
 */

import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { AuthService } from './AuthService';
import { NWCCryptoService } from './NWCCryptoService';
import { diagLog } from './DiagnosticLogger';

// IndexedDB database name and store
const DB_NAME = 'noornote_secure';
const STORE_NAME = 'keychain';
const DB_VERSION = 1;

export class KeychainStorage {
  private static dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * Get IndexedDB database (lazy initialization)
   *
   * If the open fails once, the rejected promise is dropped (not cached) so
   * the next call can retry. The WebView can evict `noornote_secure` between
   * sessions — keeping a stale rejected promise cached forever would put the
   * service in degraded mode for the whole session and bypass the mirror
   * recovery in `loadNWC`.
   */
  private static getDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
          console.error('Failed to open IndexedDB:', request.error);
          // Drop the cached rejected promise so a later call can retry —
          // otherwise a single transient IDB failure permanently degrades
          // the service for the session.
          this.dbPromise = null;
          reject(request.error);
        };

        request.onsuccess = () => {
          resolve(request.result);
        };

        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          }
        };
      });
    }
    return this.dbPromise;
  }

  /**
   * Get value from IndexedDB
   */
  private static async getFromIndexedDB(key: string): Promise<string | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        resolve(request.result?.value ?? null);
      };
    });
  }

  /**
   * Set value in IndexedDB
   */
  private static async setInIndexedDB(key: string, value: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put({ key, value });

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Delete value from IndexedDB
   */
  private static async deleteFromIndexedDB(key: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  /**
   * Get per-user NWC key name
   */
  private static getNwcKeyForUser(pubkey: string): string {
    return `nwc_${pubkey}`;
  }

  /**
   * Save NWC connection string (per-user, in IndexedDB)
   * @param connectionString The NWC connection string
   * @param pubkey The user's pubkey (required for per-user storage)
   */
  static async saveNWC(connectionString: string, pubkey?: string): Promise<void> {
    // Get pubkey from AuthService if not provided
    const userPubkey = pubkey || this.getCurrentUserPubkey();
    if (!userPubkey) {
      throw new Error('Cannot save NWC: no user pubkey available');
    }

    const key = this.getNwcKeyForUser(userPubkey);
    const encrypted = await NWCCryptoService.getInstance().encrypt(connectionString);
    await this.setInIndexedDB(key, encrypted);
    // Mirror the ciphertext to localStorage so it survives WebView IndexedDB
    // eviction. Safe: it's AES-GCM ciphertext and the device key lives in native
    // Filesystem, so the mirror is undecryptable on its own.
    this.mirrorNwcBlob(userPubkey, encrypted);
    diagLog('wallet', 'nwc_save_v2_ok', { storage: 'indexeddb', length: encrypted.length });
  }

  /** Write the encrypted NWC blob to the per-account localStorage mirror. */
  private static mirrorNwcBlob(userPubkey: string, encrypted: string): void {
    try {
      PerAccountLocalStorage.getInstance().setForPubkey(StorageKeys.NWC_BLOB_MIRROR, userPubkey, encrypted);
    } catch (err) {
      diagLog('wallet', 'nwc_mirror_save_failed', { error: String(err && (err as Error).message ? (err as Error).message : err) });
    }
  }

  /** Read the encrypted NWC blob from the per-account localStorage mirror. */
  private static readNwcMirror(userPubkey: string): string | null {
    try {
      return PerAccountLocalStorage.getInstance().getForPubkey<string | null>(StorageKeys.NWC_BLOB_MIRROR, userPubkey, null);
    } catch {
      return null;
    }
  }

  /**
   * Load NWC connection string (per-user, from IndexedDB)
   * @param pubkey The user's pubkey (optional, uses current user if not provided)
   */
  static async loadNWC(pubkey?: string): Promise<string | null> {
    // Get pubkey from AuthService if not provided
    const userPubkey = pubkey || this.getCurrentUserPubkey();
    if (!userPubkey) {
      return null;
    }

    const key = this.getNwcKeyForUser(userPubkey);
    // IDB reads can reject (open failure, transaction abort, quota, eviction).
    // Without a try/catch the rejection would propagate to NWCService and
    // bypass the localStorage mirror recovery below. Treat any IDB error as
    // "blob unavailable" and fall through to the mirror.
    let raw: string | null = null;
    try {
      raw = await this.getFromIndexedDB(key);
    } catch (err) {
      console.warn('[KeychainStorage] IDB read failed, trying mirror:', err);
      diagLog('wallet', 'nwc_load_idb_error', {
        error: String(err && (err as Error).message ? (err as Error).message : err),
      });
    }
    if (!raw) {
      // IndexedDB was empty or errored (likely a WebView eviction). Recover
      // from the localStorage ciphertext mirror and repopulate IndexedDB,
      // so the wallet stays connected without the user reconnecting.
      const mirrored = this.readNwcMirror(userPubkey);
      if (mirrored) {
        raw = mirrored;
        try { await this.setInIndexedDB(key, mirrored); } catch { /* re-mirror is best-effort */ }
        diagLog('wallet', 'nwc_load_from_mirror', { storage: 'localstorage', length: mirrored.length });
      } else {
        diagLog('wallet', 'nwc_load_empty', { storage: 'indexeddb' });
        return null;
      }
    } else if (!this.readNwcMirror(userPubkey)) {
      // Backfill migration: IDB has the blob but the localStorage mirror was
      // never written. This happens for users who saved NWC before the mirror
      // shipped (or whose mirror was wiped by a separate cause). Writing it
      // now protects the next eviction. The mirror is ciphertext-only and
      // useless without the Filesystem device key.
      this.mirrorNwcBlob(userPubkey, raw);
      diagLog('wallet', 'nwc_backfilled_mirror', { storage: 'indexeddb', length: raw.length });
    }

    // New v2 format: decrypt via NWCCryptoService
    if (NWCCryptoService.isEncryptedFormat(raw)) {
      try {
        const plaintext = await NWCCryptoService.getInstance().decrypt(raw);
        diagLog('wallet', 'nwc_load_v2_ok', { storage: 'indexeddb', length: raw.length });
        return plaintext;
      } catch (err) {
        console.error('[KeychainStorage] Failed to decrypt NWC blob:', err);
        diagLog('wallet', 'nwc_load_v2_fail', {
          storage: 'indexeddb',
          error: String(err && (err as Error).message ? (err as Error).message : err),
        });
        return null;
      }
    }

    // Legacy plaintext format (pre-v2): silently migrate to encrypted v2.
    // Any string that doesn't start with "v2:" is treated as legacy plaintext.
    diagLog('wallet', 'nwc_load_legacy_plaintext', { storage: 'indexeddb', length: raw.length });
    try {
      const reencrypted = await NWCCryptoService.getInstance().encrypt(raw);
      await this.setInIndexedDB(key, reencrypted);
      console.info('[KeychainStorage] Migrated legacy plaintext NWC blob to v2 (AES-GCM)');
      diagLog('wallet', 'nwc_migrate_ok', {
        storage: 'indexeddb',
        from: 'plaintext',
        to: 'v2',
        newLength: reencrypted.length,
      });
    } catch (migrationErr) {
      // Migration failure is non-fatal — we still return the plaintext so the
      // user stays connected. Next load will retry migration.
      console.warn('[KeychainStorage] Legacy migration re-encrypt failed:', migrationErr);
      diagLog('wallet', 'nwc_migrate_fail', {
        storage: 'indexeddb',
        from: 'plaintext',
        error: String(migrationErr && (migrationErr as Error).message ? (migrationErr as Error).message : migrationErr),
      });
    }
    return raw;
  }

  /**
   * Delete NWC connection string (per-user, from IndexedDB)
   * @param pubkey The user's pubkey (optional, uses current user if not provided)
   */
  static async deleteNWC(pubkey?: string): Promise<void> {
    // Get pubkey from AuthService if not provided
    const userPubkey = pubkey || this.getCurrentUserPubkey();
    if (!userPubkey) {
      return;
    }

    const key = this.getNwcKeyForUser(userPubkey);
    await this.deleteFromIndexedDB(key);
    // Also drop the localStorage mirror so a disconnect fully clears the NWC.
    try {
      PerAccountLocalStorage.getInstance().removeForPubkey(StorageKeys.NWC_BLOB_MIRROR, userPubkey);
    } catch { /* best-effort */ }
  }

  /**
   * Get current user's pubkey from AuthService
   */
  private static getCurrentUserPubkey(): string | null {
    try {
      const user = AuthService.getInstance().getCurrentUser();
      return user?.pubkey || null;
    } catch {
      return null;
    }
  }

  /**
   * Save zap defaults (amount + comment) to per-user localStorage
   * Non-sensitive data, localStorage is fine
   */
  static async saveZapDefaults(amount: number, comment: string): Promise<void> {
    try {
      const storage = PerAccountLocalStorage.getInstance();
      storage.set(StorageKeys.ZAP_DEFAULTS, { amount, comment });
    } catch (_error) {
      console.error('Failed to save zap defaults to localStorage:', _error);
      throw new Error('Failed to save zap defaults');
    }
  }

  /**
   * Load zap defaults (amount + comment) from per-user localStorage
   */
  static async loadZapDefaults(): Promise<{ amount: number; comment: string } | null> {
    try {
      const storage = PerAccountLocalStorage.getInstance();
      return storage.get<{ amount: number; comment: string } | null>(StorageKeys.ZAP_DEFAULTS, null);
    } catch (_error) {
      console.error('Failed to load zap defaults from localStorage:', _error);
      return null;
    }
  }

  /**
   * Delete zap defaults from per-user localStorage
   */
  static async deleteZapDefaults(): Promise<void> {
    try {
      const storage = PerAccountLocalStorage.getInstance();
      storage.remove(StorageKeys.ZAP_DEFAULTS);
    } catch (_error) {
      // Ignore errors
    }
  }

  /**
   * Save fiat currency preference to localStorage
   * Non-sensitive data, localStorage is fine
   */
  static async saveFiatCurrency(currencyCode: string): Promise<void> {
    const { PerAccountLocalStorage, StorageKeys } = await import('./PerAccountLocalStorage');
    PerAccountLocalStorage.getInstance().set(StorageKeys.FIAT_CURRENCY, currencyCode);
  }

  /**
   * Load fiat currency preference
   */
  static async loadFiatCurrency(): Promise<string | null> {
    const { PerAccountLocalStorage, StorageKeys } = await import('./PerAccountLocalStorage');
    return PerAccountLocalStorage.getInstance().get<string | null>(StorageKeys.FIAT_CURRENCY, null);
  }

  /**
   * Clear all stored credentials (including NWC)
   * WARNING: Only use this for complete app reset, NOT for logout
   */
  static async clearAll(): Promise<void> {
    await this.deleteNWC();
  }

  /**
   * Clear only auth credentials
   * NWC remains persistent across auth sessions
   * Note: nsec login removed - this method kept for compatibility
   */
  static async clearAuth(): Promise<void> {
    // No-op: nsec login removed, but method kept for compatibility
  }
}
