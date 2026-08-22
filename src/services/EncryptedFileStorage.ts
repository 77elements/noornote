/**
 * Encrypted File Storage for NWC (Desktop / Electron)
 * Stores NWC connection string in encrypted file
 * File location: ~/.noornote/{npub}/nwc.enc
 *
 * Encryption: AES-256-GCM with a device-bound random key, via NWCCryptoService.
 * Legacy format (XOR with pubkey) is detected on load and silently migrated to
 * the new v2 format. See docs/todos/nwc-encryption.md.
 *
 * Uses Electron (window.electronAPI) backend.
 */

import { PlatformService } from './PlatformService';
import { hexToNpub } from '../helpers/nip19';
import { NWCCryptoService } from './NWCCryptoService';
import { diagLog } from './DiagnosticLogger';

const platform = PlatformService.getInstance();

// ── Platform FS wrappers (Electron only) ──

async function getHomeDir(): Promise<string> {
  if (platform.isElectron) return window.electronAPI!.getHomeDir();
  throw new Error('Platform API not available for homeDir');
}

async function readTextFile(filePath: string): Promise<string> {
  if (platform.isElectron) return window.electronAPI!.readTextFile(filePath);
  throw new Error('Platform API not available for readTextFile');
}

async function writeTextFile(
  filePath: string,
  contents: string
): Promise<void> {
  if (platform.isElectron)
    return window.electronAPI!.writeTextFile(filePath, contents);
  throw new Error('Platform API not available for writeTextFile');
}

async function fsExists(filePath: string): Promise<boolean> {
  if (platform.isElectron) return window.electronAPI!.fsExists(filePath);
  throw new Error('Platform API not available for fsExists');
}

async function fsMkdir(dirPath: string): Promise<void> {
  if (platform.isElectron) return window.electronAPI!.fsMkdir(dirPath);
  throw new Error('Platform API not available for fsMkdir');
}

async function fsRemove(filePath: string): Promise<void> {
  if (platform.isElectron) return window.electronAPI!.fsRemove(filePath);
  throw new Error('Platform API not available for fsRemove');
}

export class EncryptedFileStorage {
  private static readonly NOORNOTE_DIR = '.noornote';
  private static readonly NWC_FILENAME = 'nwc.enc';

  private static async getUserDir(pubkey: string): Promise<string> {
    const home = await getHomeDir();
    const npub = hexToNpub(pubkey);
    return `${home}/${this.NOORNOTE_DIR}/${npub}`;
  }

  private static async getNwcFilePath(pubkey: string): Promise<string> {
    const userDir = await this.getUserDir(pubkey);
    return `${userDir}/${this.NWC_FILENAME}`;
  }

  private static async ensureUserDir(pubkey: string): Promise<void> {
    try {
      const userDir = await this.getUserDir(pubkey);
      const dirExists = await fsExists(userDir);

      if (!dirExists) {
        await fsMkdir(userDir);
      }
    } catch (error) {
      console.error(
        '[EncryptedFileStorage] Failed to create user directory:',
        error
      );
      throw new Error('Failed to create NWC storage directory');
    }
  }

  static async saveNWC(
    connectionString: string,
    pubkey: string
  ): Promise<void> {
    try {
      await this.ensureUserDir(pubkey);

      const encrypted =
        await NWCCryptoService.getInstance().encrypt(connectionString);
      const filePath = await this.getNwcFilePath(pubkey);

      await writeTextFile(filePath, encrypted);
      diagLog('wallet', 'nwc_save_v2_ok', {
        storage: 'file',
        length: encrypted.length,
      });
    } catch (error) {
      console.error('[EncryptedFileStorage] Failed to save NWC:', error);
      throw new Error('Failed to save NWC to encrypted file');
    }
  }

  static async loadNWC(pubkey: string): Promise<string | null> {
    try {
      const filePath = await this.getNwcFilePath(pubkey);
      const fileExists = await fsExists(filePath);

      if (!fileExists) {
        diagLog('wallet', 'nwc_load_empty', { storage: 'file' });
        return null;
      }

      const raw = await readTextFile(filePath);

      // New v2 format: decrypt via NWCCryptoService
      if (NWCCryptoService.isEncryptedFormat(raw)) {
        try {
          const plaintext = await NWCCryptoService.getInstance().decrypt(raw);
          diagLog('wallet', 'nwc_load_v2_ok', {
            storage: 'file',
            length: raw.length,
          });
          return plaintext;
        } catch (decryptErr) {
          console.error(
            '[EncryptedFileStorage] Failed to decrypt v2 NWC blob:',
            decryptErr
          );
          diagLog('wallet', 'nwc_load_v2_fail', {
            storage: 'file',
            error: String(
              decryptErr && (decryptErr as Error).message
                ? (decryptErr as Error).message
                : decryptErr
            ),
          });
          return null;
        }
      }

      // Legacy XOR format: decrypt with pubkey, then transparently migrate
      // to the new v2 format so the next load doesn't hit this path again.
      diagLog('wallet', 'nwc_load_legacy_xor', {
        storage: 'file',
        length: raw.length,
      });
      const legacyPlaintext = this.decryptLegacyXor(raw, pubkey);
      try {
        const reencrypted =
          await NWCCryptoService.getInstance().encrypt(legacyPlaintext);
        await writeTextFile(filePath, reencrypted);
        console.debug(
          '[EncryptedFileStorage] Migrated legacy XOR NWC blob to v2 (AES-GCM)'
        );
        diagLog('wallet', 'nwc_migrate_ok', {
          storage: 'file',
          from: 'xor',
          to: 'v2',
          newLength: reencrypted.length,
        });
      } catch (migrationErr) {
        // Migration failure is non-fatal — we still return the plaintext so the
        // user stays connected. Next load will retry migration.
        console.warn(
          '[EncryptedFileStorage] Legacy migration re-encrypt failed:',
          migrationErr
        );
        diagLog('wallet', 'nwc_migrate_fail', {
          storage: 'file',
          from: 'xor',
          error: String(
            migrationErr && (migrationErr as Error).message
              ? (migrationErr as Error).message
              : migrationErr
          ),
        });
      }
      return legacyPlaintext;
    } catch (error) {
      console.error('[EncryptedFileStorage] Failed to load NWC:', error);
      return null;
    }
  }

  static async deleteNWC(pubkey: string): Promise<void> {
    try {
      const filePath = await this.getNwcFilePath(pubkey);
      const fileExists = await fsExists(filePath);

      if (fileExists) {
        await fsRemove(filePath);
      }
    } catch (error) {
      console.warn('[EncryptedFileStorage] Failed to delete NWC file:', error);
    }
  }

  /**
   * Legacy XOR decryption — used ONLY during migration of pre-v2 blobs.
   * The XOR key was the user's pubkey, which is public information (it's even
   * in the file path), so this was never real encryption. Kept for one-shot
   * migration on load, then the file is immediately rewritten in v2 format.
   */
  private static decryptLegacyXor(
    encryptedBase64: string,
    key: string
  ): string {
    const encrypted = this.base64ToArrayBuffer(encryptedBase64);
    const keyBytes = new TextEncoder().encode(key);

    const decrypted = new Uint8Array(encrypted.length);
    for (let i = 0; i < encrypted.length; i++) {
      decrypted[i] = encrypted[i]! ^ keyBytes[i % keyBytes.length]!;
    }

    return new TextDecoder().decode(decrypted);
  }

  private static base64ToArrayBuffer(base64: string): Uint8Array {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  static async getDisplayPath(pubkey: string): Promise<string> {
    return this.getNwcFilePath(pubkey);
  }
}
