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
   */
  private static getDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
          console.error('Failed to open IndexedDB:', request.error);
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
    diagLog('system', 'nwc_save_v2_ok', { storage: 'indexeddb', length: encrypted.length });
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
    const raw = await this.getFromIndexedDB(key);
    if (!raw) {
      diagLog('system', 'nwc_load_empty', { storage: 'indexeddb' });
      return null;
    }

    // New v2 format: decrypt via NWCCryptoService
    if (NWCCryptoService.isEncryptedFormat(raw)) {
      try {
        const plaintext = await NWCCryptoService.getInstance().decrypt(raw);
        diagLog('system', 'nwc_load_v2_ok', { storage: 'indexeddb', length: raw.length });
        return plaintext;
      } catch (err) {
        console.error('[KeychainStorage] Failed to decrypt NWC blob:', err);
        diagLog('system', 'nwc_load_v2_fail', {
          storage: 'indexeddb',
          error: String(err && (err as Error).message ? (err as Error).message : err),
        });
        return null;
      }
    }

    // Legacy plaintext format (pre-v2): silently migrate to encrypted v2.
    // Any string that doesn't start with "v2:" is treated as legacy plaintext.
    diagLog('system', 'nwc_load_legacy_plaintext', { storage: 'indexeddb', length: raw.length });
    try {
      const reencrypted = await NWCCryptoService.getInstance().encrypt(raw);
      await this.setInIndexedDB(key, reencrypted);
      console.info('[KeychainStorage] Migrated legacy plaintext NWC blob to v2 (AES-GCM)');
      diagLog('system', 'nwc_migrate_ok', {
        storage: 'indexeddb',
        from: 'plaintext',
        to: 'v2',
        newLength: reencrypted.length,
      });
    } catch (migrationErr) {
      // Migration failure is non-fatal — we still return the plaintext so the
      // user stays connected. Next load will retry migration.
      console.warn('[KeychainStorage] Legacy migration re-encrypt failed:', migrationErr);
      diagLog('system', 'nwc_migrate_fail', {
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
