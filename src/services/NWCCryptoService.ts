/**
 * NWCCryptoService — transparent encryption for NWC connection strings.
 *
 * Goal: heimlich bessere Sicherheit ohne UX-Änderung. Siehe docs/todos/nwc-encryption.md
 *
 * Scheme:
 *   - AES-256-GCM via Web Crypto API (`window.crypto.subtle`), no npm dep
 *   - Device-bound random 32-byte key, generated once per device, stored separately
 *     from the NWC blob so trivial file-copy attacks become useless
 *   - Format: "v2:<base64-json>" where json = { iv, ciphertext } (both base64)
 *   - Random IV per encrypt call
 *   - Authenticated encryption: tampered blob → AES-GCM throws → caller returns null
 *
 * Device-key storage (explicitly separate from the NWC blob):
 *   - Desktop (Electron): ~/.noornote/device.key  (NOT inside {npub}/ — device-bound, not user-bound)
 *   - Android (Capacitor): native Filesystem file "wallet/device.key" in Directory.Data.
 *     Native app storage survives WebView IndexedDB eviction (which was wiping the key +
 *     the NWC blob together). A legacy key still in IndexedDB is migrated to the file on
 *     first read. See docs/todos/indexeddb-eviction-nwc-dm.md.
 *   - Web: IndexedDB database "noornote_device", store "keychain", key "device_key"
 *
 * Threat model (honest):
 *   Protects against trivial file-copy attacks (e.g. selective cloud backup of nwc.enc,
 *   grepping the filesystem for `nostr+walletconnect://`, copying just the blob via scp).
 *   Does NOT protect against a full device dump, root access, malicious browser extensions
 *   with page access, keyloggers, or a stolen unlocked device. Real protection against those
 *   requires a user secret (password) — explicitly rejected as UX regression.
 */

import { PlatformService } from './PlatformService';
import { diagLog } from './DiagnosticLogger';
import { openDb, type NoorDatabase } from './persistence/NoorDB';

const FORMAT_PREFIX = 'v2:';
const DEVICE_KEY_SIZE = 32; // 256 bits
const IV_SIZE = 12; // 96 bits (AES-GCM standard)

// Desktop storage location (NOT inside {npub}/ — it's device-bound)
const DESKTOP_NOORNOTE_DIR = '.noornote';
const DESKTOP_DEVICE_KEY_FILENAME = 'device.key';

// Android (Capacitor) native device-key file. Directory.Data is app-private native
// storage that the WebView cannot evict (unlike IndexedDB/localStorage).
const CAP_KEY_DIR = 'wallet';
const CAP_KEY_FILENAME = 'device.key';

// Web storage (and legacy Capacitor pre-migration) — separate DB from `noornote_secure` (NWC blob)
const IDB_DEVICE_DB_NAME = 'noornote_device';
const IDB_DEVICE_STORE = 'keychain';
const IDB_DEVICE_KEY = 'device_key';
const IDB_DEVICE_DB_VERSION = 1;

export class NWCCryptoService {
  private static instance: NWCCryptoService | null = null;
  private cachedKey: CryptoKey | null = null;
  private loadingPromise: Promise<CryptoKey> | null = null;

  private constructor() {}

  public static getInstance(): NWCCryptoService {
    if (!NWCCryptoService.instance) {
      NWCCryptoService.instance = new NWCCryptoService();
    }
    return NWCCryptoService.instance;
  }

  /**
   * Encrypt a plaintext NWC string. Returns the "v2:<base64-json>" format that
   * the storage layers persist. Idempotent-safe: encrypting and then decrypting
   * always returns the original string.
   */
  public async encrypt(plaintext: string): Promise<string> {
    const key = await this.getDeviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(IV_SIZE));
    const plaintextBytes = new TextEncoder().encode(plaintext);
    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      plaintextBytes as BufferSource
    );

    const payload = {
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertextBuffer)),
    };
    return FORMAT_PREFIX + btoa(JSON.stringify(payload));
  }

  /**
   * Decrypt a "v2:" blob. Throws if the format is invalid or the auth tag
   * fails (tampered data). Callers should catch and fall back to returning null.
   */
  public async decrypt(blob: string): Promise<string> {
    if (!blob.startsWith(FORMAT_PREFIX)) {
      throw new Error('NWCCryptoService.decrypt: missing v2 prefix');
    }
    const jsonString = atob(blob.slice(FORMAT_PREFIX.length));
    const payload = JSON.parse(jsonString) as {
      iv: string;
      ciphertext: string;
    };
    if (!payload.iv || !payload.ciphertext) {
      throw new Error('NWCCryptoService.decrypt: malformed payload');
    }

    const iv = base64ToBytes(payload.iv);
    const ciphertext = base64ToBytes(payload.ciphertext);
    const key = await this.getDeviceKey();

    const plaintextBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ciphertext as BufferSource
    );
    return new TextDecoder().decode(plaintextBuffer);
  }

  /**
   * Quick check — does a given string use the v2 encrypted format?
   * Used by the storage layers for migration sniffing.
   */
  public static isEncryptedFormat(blob: string): boolean {
    return typeof blob === 'string' && blob.startsWith(FORMAT_PREFIX);
  }

  // ========== Device Key Management ==========

  /**
   * Load the device key. Cached after first call for the lifetime of the app.
   * Concurrent calls are deduplicated via loadingPromise so the key is never
   * generated twice on first-run races.
   */
  private async getDeviceKey(): Promise<CryptoKey> {
    if (this.cachedKey) return this.cachedKey;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = this.loadOrCreateDeviceKey()
      .then(key => {
        this.cachedKey = key;
        this.loadingPromise = null;
        return key;
      })
      .catch(err => {
        this.loadingPromise = null;
        throw err;
      });
    return this.loadingPromise;
  }

  private async loadOrCreateDeviceKey(): Promise<CryptoKey> {
    let keyBytes = await this.readStoredKeyBytes();
    const wasCreated = !keyBytes;
    if (!keyBytes) {
      keyBytes = crypto.getRandomValues(new Uint8Array(DEVICE_KEY_SIZE));
      await this.writeStoredKeyBytes(keyBytes);
    }
    const platform = PlatformService.getInstance();
    const storage = platform.isElectron
      ? 'file'
      : platform.isCapacitor
        ? 'capacitor-fs'
        : 'indexeddb';
    const platformName = platform.isElectron
      ? 'electron'
      : platform.isCapacitor
        ? 'capacitor'
        : 'web';
    diagLog(
      'wallet',
      wasCreated ? 'nwc_device_key_created' : 'nwc_device_key_loaded',
      {
        platform: platformName,
        storage,
      }
    );
    return crypto.subtle.importKey(
      'raw',
      keyBytes as BufferSource,
      { name: 'AES-GCM' },
      false, // non-extractable — raw bytes never leave the Web Crypto boundary after import
      ['encrypt', 'decrypt']
    );
  }

  private async readStoredKeyBytes(): Promise<Uint8Array | null> {
    const platform = PlatformService.getInstance();
    if (platform.isElectron) {
      return this.readDesktopKey();
    }
    if (platform.isCapacitor) {
      return this.readCapacitorKey();
    }
    return this.readIndexedDBKey();
  }

  private async writeStoredKeyBytes(keyBytes: Uint8Array): Promise<void> {
    const platform = PlatformService.getInstance();
    if (platform.isElectron) {
      await this.writeDesktopKey(keyBytes);
      return;
    }
    if (platform.isCapacitor) {
      await this.writeCapacitorFsKey(keyBytes);
      return;
    }
    await this.writeIndexedDBKey(keyBytes);
  }

  // ----- Desktop (Electron) -----

  private async desktopKeyPath(): Promise<string> {
    const home = await window.electronAPI!.getHomeDir();
    return `${home}/${DESKTOP_NOORNOTE_DIR}/${DESKTOP_DEVICE_KEY_FILENAME}`;
  }

  private async readDesktopKey(): Promise<Uint8Array | null> {
    try {
      const path = await this.desktopKeyPath();
      const exists = await window.electronAPI!.fsExists(path);
      if (!exists) return null;
      const b64 = await window.electronAPI!.readTextFile(path);
      return base64ToBytes(b64.trim());
    } catch (err) {
      console.debug('[NWCCryptoService] readDesktopKey failed:', err);
      return null;
    }
  }

  private async writeDesktopKey(keyBytes: Uint8Array): Promise<void> {
    const home = await window.electronAPI!.getHomeDir();
    const dir = `${home}/${DESKTOP_NOORNOTE_DIR}`;
    const dirExists = await window.electronAPI!.fsExists(dir);
    if (!dirExists) {
      await window.electronAPI!.fsMkdir(dir);
    }
    const path = `${dir}/${DESKTOP_DEVICE_KEY_FILENAME}`;
    await window.electronAPI!.writeTextFile(path, bytesToBase64(keyBytes));
  }

  // ----- Android (Capacitor) — native Filesystem (survives WebView eviction) -----

  /**
   * Read the device key on Capacitor. Prefers the native Filesystem copy (which
   * survives WebView IndexedDB eviction). If only a legacy IndexedDB key exists
   * (from before this migration), it is moved to the Filesystem so the existing
   * encrypted NWC blobs stay decryptable after the next eviction.
   */
  private async readCapacitorKey(): Promise<Uint8Array | null> {
    const fromFs = await this.readCapacitorFsKey();
    if (fromFs) return fromFs;

    const legacy = await this.readIndexedDBKey();
    if (legacy) {
      try {
        await this.writeCapacitorFsKey(legacy);
        diagLog('wallet', 'nwc_device_key_migrated', {
          from: 'indexeddb',
          to: 'capacitor-fs',
        });
      } catch (err) {
        diagLog('wallet', 'nwc_device_key_migrate_failed', {
          error: String(err),
        });
      }
      return legacy;
    }
    return null;
  }

  private async readCapacitorFsKey(): Promise<Uint8Array | null> {
    try {
      const { Filesystem, Directory, Encoding } = await import(
        '@capacitor/filesystem'
      );
      const result = await Filesystem.readFile({
        path: `${CAP_KEY_DIR}/${CAP_KEY_FILENAME}`,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      const b64 = typeof result.data === 'string' ? result.data.trim() : '';
      if (!b64) return null;
      return base64ToBytes(b64);
    } catch {
      // File not found / unreadable → treat as no key yet.
      return null;
    }
  }

  private async writeCapacitorFsKey(keyBytes: Uint8Array): Promise<void> {
    const { Filesystem, Directory, Encoding } = await import(
      '@capacitor/filesystem'
    );
    await Filesystem.writeFile({
      path: `${CAP_KEY_DIR}/${CAP_KEY_FILENAME}`,
      data: bytesToBase64(keyBytes),
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      recursive: true,
    });
  }

  // ----- Web (IndexedDB); also legacy Capacitor key source pre-migration -----

  /** Cached NoorDB-Verbindung zur Device-Key-DB (global, account-unabhängig). */
  private deviceDb: NoorDatabase | null = null;

  private async openDeviceDB(): Promise<NoorDatabase> {
    if (this.deviceDb?.isOpen) return this.deviceDb;
    this.deviceDb = await openDb(IDB_DEVICE_DB_NAME, {
      version: IDB_DEVICE_DB_VERSION,
      stores: [{ name: IDB_DEVICE_STORE, keyPath: 'key' }],
    });
    return this.deviceDb;
  }

  private async readIndexedDBKey(): Promise<Uint8Array | null> {
    try {
      const db = await this.openDeviceDB();
      const record = await db.get<{ key: string; value: string }>(
        IDB_DEVICE_STORE,
        IDB_DEVICE_KEY
      );
      if (!record || typeof record.value !== 'string') {
        return null;
      }
      try {
        return base64ToBytes(record.value);
      } catch {
        return null;
      }
    } catch (err) {
      console.debug('[NWCCryptoService] readIndexedDBKey failed:', err);
      return null;
    }
  }

  private async writeIndexedDBKey(keyBytes: Uint8Array): Promise<void> {
    const db = await this.openDeviceDB();
    await db.put(IDB_DEVICE_STORE, {
      key: IDB_DEVICE_KEY,
      value: bytesToBase64(keyBytes),
    });
  }
}

// ========== base64 helpers (binary-safe) ==========

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
