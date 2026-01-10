/**
 * Encrypted File Storage for NWC
 * Stores NWC connection string in encrypted file
 * File location: ~/.noornote/{npub}/nwc.enc
 */

import { readTextFile, writeTextFile, exists, remove, mkdir } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { hexToNpub } from '../helpers/nip19';

export class EncryptedFileStorage {
  private static readonly NOORNOTE_DIR = '.noornote';
  private static readonly NWC_FILENAME = 'nwc.enc';

  /**
   * Get absolute directory path for user's data: ~/.noornote/{npub}/
   */
  private static async getUserDir(pubkey: string): Promise<string> {
    const home = await homeDir();
    const npub = hexToNpub(pubkey);
    return `${home}/${this.NOORNOTE_DIR}/${npub}`;
  }

  /**
   * Get absolute file path for user's NWC: ~/.noornote/{npub}/nwc.enc
   */
  private static async getNwcFilePath(pubkey: string): Promise<string> {
    const userDir = await this.getUserDir(pubkey);
    return `${userDir}/${this.NWC_FILENAME}`;
  }

  /**
   * Ensure user directory exists
   */
  private static async ensureUserDir(pubkey: string): Promise<void> {
    try {
      const userDir = await this.getUserDir(pubkey);
      const dirExists = await exists(userDir);

      if (!dirExists) {
        await mkdir(userDir, { recursive: true });
      }
    } catch (error) {
      console.error('[EncryptedFileStorage] Failed to create user directory:', error);
      throw new Error('Failed to create NWC storage directory');
    }
  }

  /**
   * Save NWC to encrypted file
   * Uses simple XOR encryption with user's pubkey as key
   */
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

  /**
   * Load NWC from encrypted file
   */
  static async loadNWC(pubkey: string): Promise<string | null> {
    try {
      const filePath = await this.getNwcFilePath(pubkey);
      const fileExists = await exists(filePath);

      if (!fileExists) return null;

      const encrypted = await readTextFile(filePath);
      return this.decrypt(encrypted, pubkey);
    } catch (error) {
      console.error('[EncryptedFileStorage] Failed to load NWC:', error);
      return null;
    }
  }

  /**
   * Delete NWC file
   */
  static async deleteNWC(pubkey: string): Promise<void> {
    try {
      const filePath = await this.getNwcFilePath(pubkey);
      const fileExists = await exists(filePath);

      if (fileExists) {
        await remove(filePath);
      }
    } catch (error) {
      // Ignore errors - file might not exist
      console.warn('[EncryptedFileStorage] Failed to delete NWC file:', error);
    }
  }

  /**
   * Simple XOR encryption (good enough for local file protection)
   * Takes plaintext and key (pubkey), returns base64-encoded encrypted data
   */
  private static encrypt(text: string, key: string): string {
    // Convert text and key to Uint8Arrays
    const textBytes = new TextEncoder().encode(text);
    const keyBytes = new TextEncoder().encode(key);

    // XOR each byte with corresponding key byte (cycling through key)
    const encrypted = new Uint8Array(textBytes.length);
    for (let i = 0; i < textBytes.length; i++) {
      encrypted[i] = textBytes[i]! ^ keyBytes[i % keyBytes.length]!;
    }

    // Convert to base64 for storage
    return this.arrayBufferToBase64(encrypted);
  }

  /**
   * Decrypt XOR-encrypted base64 data
   */
  private static decrypt(encryptedBase64: string, key: string): string {
    // Decode base64 to Uint8Array
    const encrypted = this.base64ToArrayBuffer(encryptedBase64);
    const keyBytes = new TextEncoder().encode(key);

    // XOR each byte with corresponding key byte (same operation as encryption)
    const decrypted = new Uint8Array(encrypted.length);
    for (let i = 0; i < encrypted.length; i++) {
      decrypted[i] = encrypted[i]! ^ keyBytes[i % keyBytes.length]!;
    }

    // Convert back to string
    return new TextDecoder().decode(decrypted);
  }

  /**
   * Convert Uint8Array to base64 string
   */
  private static arrayBufferToBase64(buffer: Uint8Array): string {
    let binary = '';
    const len = buffer.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(buffer[i]!);
    }
    return btoa(binary);
  }

  /**
   * Convert base64 string to Uint8Array
   */
  private static base64ToArrayBuffer(base64: string): Uint8Array {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Get display path (for showing user where file is stored)
   */
  static async getDisplayPath(pubkey: string): Promise<string> {
    return this.getNwcFilePath(pubkey);
  }
}
