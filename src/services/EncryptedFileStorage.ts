/**
 * Encrypted File Storage for NWC
 * Stores NWC connection string in encrypted file
 * File location: ~/.noornote/{npub}/nwc.enc
 *
 * Supports both Electron (window.electronAPI) and Tauri (@tauri-apps/plugin-fs) backends.
 */

import { PlatformService } from './PlatformService';
import { hexToNpub } from '../helpers/nip19';

const platform = PlatformService.getInstance();

// ── Platform-agnostic FS wrappers ──

async function getHomeDir(): Promise<string> {
  if (platform.isElectron) return window.electronAPI!.getHomeDir();
  const { homeDir } = await import('@tauri-apps/api/path');
  return homeDir();
}

async function readTextFile(filePath: string): Promise<string> {
  if (platform.isElectron) return window.electronAPI!.readTextFile(filePath);
  const mod = await import('@tauri-apps/plugin-fs');
  return mod.readTextFile(filePath);
}

async function writeTextFile(filePath: string, contents: string): Promise<void> {
  if (platform.isElectron) return window.electronAPI!.writeTextFile(filePath, contents);
  const mod = await import('@tauri-apps/plugin-fs');
  return mod.writeTextFile(filePath, contents);
}

async function fsExists(filePath: string): Promise<boolean> {
  if (platform.isElectron) return window.electronAPI!.fsExists(filePath);
  const mod = await import('@tauri-apps/plugin-fs');
  return mod.exists(filePath);
}

async function fsMkdir(dirPath: string): Promise<void> {
  if (platform.isElectron) return window.electronAPI!.fsMkdir(dirPath);
  const mod = await import('@tauri-apps/plugin-fs');
  return mod.mkdir(dirPath, { recursive: true });
}

async function fsRemove(filePath: string): Promise<void> {
  if (platform.isElectron) return window.electronAPI!.fsRemove(filePath);
  const mod = await import('@tauri-apps/plugin-fs');
  return mod.remove(filePath);
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
      console.error('[EncryptedFileStorage] Failed to create user directory:', error);
      throw new Error('Failed to create NWC storage directory');
    }
  }

  static async saveNWC(connectionString: string, pubkey: string): Promise<void> {
    try {
      await this.ensureUserDir(pubkey);

      const encrypted = this.encrypt(connectionString, pubkey);
      const filePath = await this.getNwcFilePath(pubkey);

      await writeTextFile(filePath, encrypted);
    } catch (error) {
      console.error('[EncryptedFileStorage] Failed to save NWC:', error);
      throw new Error('Failed to save NWC to encrypted file');
    }
  }

  static async loadNWC(pubkey: string): Promise<string | null> {
    try {
      const filePath = await this.getNwcFilePath(pubkey);
      const fileExists = await fsExists(filePath);

      if (!fileExists) return null;

      const encrypted = await readTextFile(filePath);
      return this.decrypt(encrypted, pubkey);
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

  private static encrypt(text: string, key: string): string {
    const textBytes = new TextEncoder().encode(text);
    const keyBytes = new TextEncoder().encode(key);

    const encrypted = new Uint8Array(textBytes.length);
    for (let i = 0; i < textBytes.length; i++) {
      encrypted[i] = textBytes[i]! ^ keyBytes[i % keyBytes.length]!;
    }

    return this.arrayBufferToBase64(encrypted);
  }

  private static decrypt(encryptedBase64: string, key: string): string {
    const encrypted = this.base64ToArrayBuffer(encryptedBase64);
    const keyBytes = new TextEncoder().encode(key);

    const decrypted = new Uint8Array(encrypted.length);
    for (let i = 0; i < encrypted.length; i++) {
      decrypted[i] = encrypted[i]! ^ keyBytes[i % keyBytes.length]!;
    }

    return new TextDecoder().decode(decrypted);
  }

  private static arrayBufferToBase64(buffer: Uint8Array): string {
    let binary = '';
    const len = buffer.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(buffer[i]!);
    }
    return btoa(binary);
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
