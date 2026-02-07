/**
 * Nip46SignerManager
 * Encapsulates all NIP-46 Remote Signer (bunker://) functionality
 *
 * Handles:
 * - Bunker URI authentication
 * - NostrConnect QR flow
 * - Session persistence and restore
 * - RPC connection management
 * - Event signing delegation
 */

import { NDKNip46Signer, NDKUser } from '@nostr-dev-kit/ndk';
import { hexToNpub } from '../../helpers/nip19';
import { PlatformService } from '../PlatformService';

const NIP46_STORAGE_KEY = 'noornote_nip46_payload';

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

export class Nip46SignerManager {
  private bunkerSigner: NDKNip46Signer | null = null;

  /**
   * Authenticate with NIP-46 bunker:// URI
   */
  public async authenticate(bunkerUri: string): Promise<Nip46AuthResult> {
    try {
      // Validate bunker URI format
      if (!bunkerUri.startsWith('bunker://')) {
        return {
          success: false,
          error: 'Invalid bunker URI format. Must start with bunker://'
        };
      }

      // Get NDK instance from NostrTransport
      const { NostrTransport } = await import('../transport/NostrTransport');
      const ndk = NostrTransport.getInstance().getNDK();

      // Check if we have a stored local signer key for this session
      const storedPayload = localStorage.getItem(NIP46_STORAGE_KEY);
      let localNsec: string | undefined;

      if (storedPayload) {
        try {
          const parsed = JSON.parse(storedPayload);
          if (parsed.payload?.localSignerPayload) {
            const localSignerParsed = JSON.parse(parsed.payload.localSignerPayload);
            localNsec = localSignerParsed.payload?.nsec;
          }
        } catch {
          // Ignore parse errors, will generate new key
        }
      }

      // Create NIP-46 signer using NDK's static bunker() method
      this.bunkerSigner = NDKNip46Signer.bunker(ndk, bunkerUri, localNsec);

      // Listen for auth URL events (for bunkers that require authorization)
      this.bunkerSigner.on('authUrl', (url: string) => {
        window.open(url, '_blank', 'width=600,height=700');
      });

      const secret = this.bunkerSigner.secret;
      const bunkerPubkey = this.bunkerSigner.bunkerPubkey;

      // Pre-set userPubkey to bunkerPubkey for hardware signers
      if (!this.bunkerSigner.userPubkey && bunkerPubkey) {
        this.bunkerSigner.userPubkey = bunkerPubkey;
      }

      // Force NIP-04 encryption for hardware signers
      this.bunkerSigner.rpc.encryptionType = 'nip04';

      // Start RPC subscription
      const localUser = await this.bunkerSigner.localSigner.user();
      await this.bunkerSigner.rpc.subscribe({
        kinds: [24133],
        '#p': [localUser.pubkey],
      });

      // Send connect request and wait for response
      const pubkey = await new Promise<string>((resolve, reject) => {
        const timeoutMs = 30000;
        const timeout = setTimeout(() => {
          reject(new Error(`Bunker connection timeout after ${timeoutMs / 1000}s`));
        }, timeoutMs);

        const responseHandler = (response: any) => {
          // Hardware signers respond with the secret as confirmation
          if (response?.result === secret) {
            clearTimeout(timeout);
            resolve(bunkerPubkey!);
          } else if (response?.result === 'ack') {
            clearTimeout(timeout);
            resolve(bunkerPubkey!);
          } else if (response?.error) {
            clearTimeout(timeout);
            reject(new Error(response.error));
          }
        };

        this.bunkerSigner!.rpc.on('response', responseHandler);
        this.bunkerSigner!.rpc.sendRequest(
          bunkerPubkey!,
          'connect',
          [bunkerPubkey!, secret!],
          24133
        );
      });

      const npub = hexToNpub(pubkey);
      if (!npub) {
        return {
          success: false,
          error: 'Failed to convert pubkey to npub'
        };
      }

      // Store signer payload for session restore
      const signerPayload = this.bunkerSigner.toPayload();
      localStorage.setItem(NIP46_STORAGE_KEY, signerPayload);

      return {
        success: true,
        npub,
        pubkey
      };
    } catch (error: unknown) {
      this.bunkerSigner = null;

      let errorMessage = 'Bunker authentication failed';
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      } else if (error && typeof error === 'object' && 'message' in error) {
        errorMessage = String((error as { message: unknown }).message);
      }

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Start a nostrconnect:// flow — generates URI for QR display,
   * returns a listener that resolves when a remote signer connects.
   */
  public async startNostrConnect(): Promise<NostrConnectSession> {
    const { NostrTransport } = await import('../transport/NostrTransport');
    const ndk = NostrTransport.getInstance().getNDK();

    // relay.nsec.app works in browsers but causes kCFErrorDomainCFNetwork 303 in Tauri's WKWebView
    const relay = PlatformService.getInstance().isTauri
      ? 'wss://relay.primal.net'
      : 'wss://relay.nsec.app';

    const signer = NDKNip46Signer.nostrconnect(ndk, relay, undefined, {
      name: 'NoorNote',
      url: 'https://noornote.app'
    });

    const uri = signer.nostrConnectUri!;
    let cancelled = false;
    let cancelReject: (() => void) | null = null;

    const waitForConnection = async (): Promise<Nip46AuthResult> => {
      try {
        const user = await Promise.race([
          signer.blockUntilReady(),
          new Promise<never>((_, reject) => {
            cancelReject = () => reject(new Error('Cancelled'));
          })
        ]);

        if (cancelled) {
          signer.stop();
          return { success: false, error: 'Cancelled' };
        }

        this.bunkerSigner = signer;
        const pubkey = user.pubkey;
        const npub = hexToNpub(pubkey);

        if (!npub) {
          signer.stop();
          return { success: false, error: 'Failed to convert pubkey to npub' };
        }

        const signerPayload = signer.toPayload();
        localStorage.setItem(NIP46_STORAGE_KEY, signerPayload);

        return { success: true, npub, pubkey };
      } catch (error) {
        if (cancelled) return { success: false, error: 'Cancelled' };
        signer.stop();
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, error: msg };
      }
    };

    const cancel = () => {
      cancelled = true;
      cancelReject?.();
      signer.stop();
    };

    return { uri, waitForConnection, cancel };
  }

  /**
   * Restore NIP-46 session from stored payload
   * Re-establishes the RPC connection to the remote signer
   */
  public async restoreSession(): Promise<boolean> {
    const storedPayload = localStorage.getItem(NIP46_STORAGE_KEY);
    if (!storedPayload) {
      return false;
    }

    try {
      // Get NDK instance from NostrTransport
      const { NostrTransport } = await import('../transport/NostrTransport');
      const ndk = NostrTransport.getInstance().getNDK();

      // Restore signer from payload
      this.bunkerSigner = await NDKNip46Signer.fromPayload(storedPayload, ndk);

      // Re-establish RPC connection
      const secret = this.bunkerSigner.secret;
      const bunkerPubkey = this.bunkerSigner.bunkerPubkey;

      // Pre-set userPubkey to bunkerPubkey for hardware signers
      if (!this.bunkerSigner.userPubkey && bunkerPubkey) {
        this.bunkerSigner.userPubkey = bunkerPubkey;
      }

      // Force NIP-04 encryption for hardware signers
      this.bunkerSigner.rpc.encryptionType = 'nip04';

      // Start RPC subscription
      const localUser = await this.bunkerSigner.localSigner.user();
      await this.bunkerSigner.rpc.subscribe({
        kinds: [24133],
        '#p': [localUser.pubkey],
      });

      // Send connect request and wait for response
      await new Promise<void>((resolve, reject) => {
        const timeoutMs = 15000;
        const timeout = setTimeout(() => {
          reject(new Error('Session restore timeout'));
        }, timeoutMs);

        const responseHandler = (response: any) => {
          if (response?.result === secret || response?.result === 'ack') {
            clearTimeout(timeout);
            resolve();
          } else if (response?.error) {
            clearTimeout(timeout);
            reject(new Error(response.error));
          }
        };

        this.bunkerSigner!.rpc.on('response', responseHandler);
        this.bunkerSigner!.rpc.sendRequest(
          bunkerPubkey!,
          'connect',
          [bunkerPubkey!, secret!],
          24133
        );
      });

      return true;
    } catch {
      localStorage.removeItem(NIP46_STORAGE_KEY);
      this.bunkerSigner = null;
      return false;
    }
  }

  /**
   * Sign an event using the remote signer
   */
  public async signEvent(event: any): Promise<string> {
    if (!this.bunkerSigner) {
      throw new Error('NIP-46 signer not available');
    }
    return await this.bunkerSigner.sign(event);
  }

  /**
   * NIP-44 encrypt using the remote signer
   * @param plaintext - Text to encrypt
   * @param recipientPubkey - Recipient's public key (hex)
   * @returns Encrypted ciphertext
   */
  public async nip44Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    if (!this.bunkerSigner) {
      throw new Error('NIP-46 signer not available');
    }
    const recipient = new NDKUser({ pubkey: recipientPubkey });
    return await this.bunkerSigner.encrypt(recipient, plaintext);
  }

  /**
   * NIP-44 decrypt using the remote signer
   * @param ciphertext - Encrypted text to decrypt
   * @param senderPubkey - Sender's public key (hex)
   * @returns Decrypted plaintext
   */
  public async nip44Decrypt(ciphertext: string, senderPubkey: string): Promise<string> {
    if (!this.bunkerSigner) {
      throw new Error('NIP-46 signer not available');
    }
    const sender = new NDKUser({ pubkey: senderPubkey });
    return await this.bunkerSigner.decrypt(sender, ciphertext);
  }

  /**
   * NIP-04 encrypt using the remote signer (legacy, fallback)
   * @param plaintext - Text to encrypt
   * @param recipientPubkey - Recipient's public key (hex)
   * @returns Encrypted ciphertext
   */
  public async nip04Encrypt(plaintext: string, recipientPubkey: string): Promise<string> {
    if (!this.bunkerSigner) {
      throw new Error('NIP-46 signer not available');
    }
    const recipient = new NDKUser({ pubkey: recipientPubkey });
    return await this.bunkerSigner.encrypt(recipient, plaintext, 'nip04');
  }

  /**
   * NIP-04 decrypt using the remote signer (legacy, fallback)
   * @param ciphertext - Encrypted text to decrypt
   * @param senderPubkey - Sender's public key (hex)
   * @returns Decrypted plaintext
   */
  public async nip04Decrypt(ciphertext: string, senderPubkey: string): Promise<string> {
    if (!this.bunkerSigner) {
      throw new Error('NIP-46 signer not available');
    }
    const sender = new NDKUser({ pubkey: senderPubkey });
    return await this.bunkerSigner.decrypt(sender, ciphertext, 'nip04');
  }

  /**
   * Check if signer is available
   */
  public isAvailable(): boolean {
    return this.bunkerSigner !== null;
  }

  /**
   * Check if there's a stored session
   */
  public hasStoredSession(): boolean {
    return localStorage.getItem(NIP46_STORAGE_KEY) !== null;
  }

  /**
   * Cleanup and stop the signer
   */
  public cleanup(): void {
    if (this.bunkerSigner) {
      this.bunkerSigner.stop();
      this.bunkerSigner = null;
    }
    localStorage.removeItem(NIP46_STORAGE_KEY);
  }

  /**
   * Stop the signer without clearing storage (for logout without clearing session)
   */
  public stop(): void {
    if (this.bunkerSigner) {
      this.bunkerSigner.stop();
      this.bunkerSigner = null;
    }
  }
}
