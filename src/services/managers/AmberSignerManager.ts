/**
 * AmberSignerManager
 * Manages Amber (NIP-55) Android signer connection
 *
 * @purpose Handle Amber-specific login and signing logic separate from core auth
 * @used-by AuthService
 */

import { AmberSignerService } from '../AmberSignerService';
import { encodeNpub, decodeNip19 } from '../NostrToolsAdapter';

export interface AmberAuthResult {
  success: boolean;
  npub?: string;
  pubkey?: string;
  error?: string;
}

const AMBER_SESSION_KEY = 'noornote_amber_session';

export class AmberSignerManager {
  private amberService: AmberSignerService;
  private pubkey: string = '';

  constructor() {
    this.amberService = AmberSignerService.getInstance();
  }

  async isAvailable(): Promise<boolean> {
    return this.amberService.isAvailable();
  }

  async authenticate(): Promise<AmberAuthResult> {
    try {
      const result = await this.amberService.login();

      if (!result.pubkey) {
        return { success: false, error: 'Amber returned empty pubkey' };
      }

      // Amber returns npub (bech32) by default per NIP-55, not hex
      const raw = result.pubkey.trim();
      let pubkey: string;
      let npub: string;

      if (raw.startsWith('npub1')) {
        // Decode npub bech32 → hex
        const decoded = decodeNip19(raw);
        pubkey = decoded.data as string;
        npub = raw;
      } else {
        // Hex format (fallback) — pad to 64 chars
        pubkey = raw.padStart(64, '0');
        npub = encodeNpub(pubkey);
      }

      if (pubkey.length !== 64) {
        return {
          success: false,
          error: `Invalid pubkey from Amber (length ${pubkey.length})`,
        };
      }

      this.pubkey = pubkey;

      // Save package name + npub for session restore
      localStorage.setItem(
        AMBER_SESSION_KEY,
        JSON.stringify({
          packageName: result.packageName,
          pubkey,
          npub,
        })
      );

      return { success: true, npub, pubkey };
    } catch (error) {
      console.error('[AmberSignerManager] Login failed:', error);
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: msg || 'Amber login failed' };
    }
  }

  restoreSession(): boolean {
    try {
      const stored = localStorage.getItem(AMBER_SESSION_KEY);
      if (!stored) return false;

      const session = JSON.parse(stored);
      if (session.packageName && session.pubkey) {
        this.amberService.setPackageName(session.packageName);
        this.pubkey = session.pubkey;
        // Restore npub for signing (required by nostr-signer-capacitor-plugin)
        if (session.npub) {
          this.amberService.setNpub(session.npub);
        } else {
          // Legacy session without npub — convert from hex
          const npub = encodeNpub(session.pubkey);
          this.amberService.setNpub(npub);
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async signEvent(event: any): Promise<string> {
    const eventJson = JSON.stringify({
      kind: event.kind,
      content: event.content,
      tags: event.tags,
      created_at: event.created_at,
      pubkey: event.pubkey,
    });

    const result = await this.amberService.signEvent(eventJson, this.pubkey);
    return result.event;
  }

  async nip04Encrypt(
    plaintext: string,
    recipientPubkey: string
  ): Promise<string> {
    return this.amberService.nip04Encrypt(
      plaintext,
      recipientPubkey,
      this.pubkey
    );
  }

  async nip04Decrypt(
    ciphertext: string,
    senderPubkey: string
  ): Promise<string> {
    return this.amberService.nip04Decrypt(
      ciphertext,
      senderPubkey,
      this.pubkey
    );
  }

  async nip44Encrypt(
    plaintext: string,
    recipientPubkey: string
  ): Promise<string> {
    return this.amberService.nip44Encrypt(
      plaintext,
      recipientPubkey,
      this.pubkey
    );
  }

  async nip44Decrypt(
    ciphertext: string,
    senderPubkey: string
  ): Promise<string> {
    return this.amberService.nip44Decrypt(
      ciphertext,
      senderPubkey,
      this.pubkey
    );
  }

  cleanup(): void {
    localStorage.removeItem(AMBER_SESSION_KEY);
    this.pubkey = '';
  }

  getPubkey(): string {
    return this.pubkey;
  }
}
