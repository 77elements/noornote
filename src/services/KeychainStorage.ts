/**
 * Keychain Storage Service
 * Secure storage for sensitive data (NWC connection strings)
 * Uses IndexedDB for browser/web storage.
 * Desktop (Electron) uses EncryptedFileStorage for NWC, not this service.
 *
 * IndexedDB is used instead of localStorage because:
 * - Not synchronously accessible via JS (harder to exploit via XSS)
 * - Isolated per origin
 * - Still not fully secure in browser - use desktop app for best security
 */

import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { AuthService } from './AuthService';

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
    await this.setInIndexedDB(key, connectionString);
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
    return this.getFromIndexedDB(key);
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
