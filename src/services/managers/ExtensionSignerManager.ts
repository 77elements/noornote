/**
 * ExtensionSignerManager
 * Handles NIP-07 browser extension authentication and signing.
 * Web-only — extensions are not available in Tauri.
 */

export interface NostrExtension {
  getPublicKey(): Promise<string>;
  signEvent(event: any): Promise<any>;
  nip04?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

export class ExtensionSignerManager {
  private extension: NostrExtension | null = null;

  public isAvailable(): boolean {
    return typeof window.nostr !== 'undefined';
  }

  public getExtensionName(): string {
    if (!this.isAvailable()) return 'none';
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('alby')) return 'Alby';
    return 'Browser Extension';
  }

  /**
   * Authenticate via NIP-07 browser extension.
   * Calls getPublicKey() and stores the extension reference.
   */
  public async authenticate(): Promise<{ success: boolean; npub?: string; pubkey?: string; error?: string }> {
    if (!this.isAvailable()) {
      return { success: false, error: 'No Nostr extension found. Please install Alby, nos2x, or another Nostr browser extension.' };
    }

    try {
      this.extension = window.nostr!;
      const pubkey = await this.extension.getPublicKey();

      if (!pubkey) {
        return { success: false, error: 'Failed to get public key from extension' };
      }

      const { hexToNpub } = await import('../../helpers/nip19');
      const npub = hexToNpub(pubkey);

      if (!npub) {
        throw new Error(`${this.getExtensionName()} extension provided invalid hex pubkey`);
      }

      return { success: true, npub, pubkey };
    } catch (error) {
      console.error('Extension authentication failed:', error);
      this.extension = null;
      return { success: false, error: error instanceof Error ? error.message : 'Authentication failed' };
    }
  }

  /**
   * Restore extension reference without calling getPublicKey().
   * Keychat's getPublicKey forces an identity picker on every call,
   * so we trust the stored session and just grab window.nostr.
   */
  public async restoreConnection(): Promise<boolean> {
    const maxRetries = 10;
    const retryDelay = 200;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (this.isAvailable()) break;
      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    if (!this.isAvailable()) {
      console.warn('[ExtensionSigner] Extension not available after retries');
      return false;
    }

    this.extension = window.nostr!;
    return true;
  }

  // ── Signing & Crypto ──────────────────────────────────────────────

  public async signEvent(event: any): Promise<any> {
    if (!this.extension) throw new Error('Extension not available');
    return this.extension.signEvent(event);
  }

  public async nip44Encrypt(plaintext: string, pubkey: string): Promise<string> {
    if (!this.extension?.nip44) throw new Error('Extension NIP-44 not available');
    return this.extension.nip44.encrypt(pubkey, plaintext);
  }

  public async nip44Decrypt(ciphertext: string, pubkey: string): Promise<string> {
    if (!this.extension?.nip44) throw new Error('Extension NIP-44 not available');
    return this.extension.nip44.decrypt(pubkey, ciphertext);
  }

  public async nip04Encrypt(plaintext: string, pubkey: string): Promise<string> {
    if (!this.extension?.nip04) throw new Error('Extension NIP-04 not available');
    return this.extension.nip04.encrypt(pubkey, plaintext);
  }

  public async nip04Decrypt(ciphertext: string, pubkey: string): Promise<string> {
    if (!this.extension?.nip04) throw new Error('Extension NIP-04 not available');
    return this.extension.nip04.decrypt(pubkey, ciphertext);
  }

  // ── State ─────────────────────────────────────────────────────────

  public isSignerAvailable(): boolean {
    return this.extension !== null;
  }

  public cleanup(): void {
    this.extension = null;
  }
}
