/**
 * BunkerSignerManager
 * Handles bunker:// URI authentication via NIP-46.
 * Isolated from NostrConnect QR flow — each has its own signer lifecycle.
 *
 * NIP-44 support varies by remote signer:
 * - Software signers (Amber, nsecBunker): typically support NIP-44 (XChaCha20-Poly1305)
 * - LNBits nostr-signing-device (ESP32 hardware): NIP-04 only (AES-256-CBC).
 *   Firmware commands /encrypt-message and /decrypt-message are NIP-04 only.
 *   No XChaCha20-Poly1305 implementation exists in the firmware.
 *   Source: github.com/nicolgit/nostr-signing-device
 *
 * Because NIP-17 direct messages require NIP-44 for gift wrap encryption,
 * DMService probes NIP-44 capability on login and disables NIP-17 DM
 * fetching when the signer does not support it.
 */

import { NDKNip46Signer } from '@nostr-dev-kit/ndk';
import { hexToNpub } from '../../helpers/nip19';
import { Nip46BaseManager, NIP46_STORAGE_KEY, nip46Log, type Nip46AuthResult } from './Nip46BaseManager';

export class BunkerSignerManager extends Nip46BaseManager {

  /**
   * Authenticate with a bunker:// URI.
   * Creates a new NDKNip46Signer, locks encryption to NIP-04,
   * and waits for the remote signer to confirm the connection.
   */
  public async authenticate(bunkerUri: string): Promise<Nip46AuthResult> {
    try {
      if (!bunkerUri.startsWith('bunker://')) {
        return { success: false, error: 'Invalid bunker URI format. Must start with bunker://' };
      }

      const { NostrTransport } = await import('../transport/NostrTransport');
      const ndk = NostrTransport.getInstance().getNDK();

      // Reuse stored local key if available (avoids generating a new keypair)
      const storedPayload = localStorage.getItem(NIP46_STORAGE_KEY);
      let localNsec: string | undefined;

      if (storedPayload) {
        try {
          const parsed = JSON.parse(storedPayload);
          if (parsed.payload?.localSignerPayload) {
            const localSignerParsed = JSON.parse(parsed.payload.localSignerPayload);
            localNsec = localSignerParsed.payload?.nsec;
          }
          nip46Log.info('Reusing stored local key');
        } catch {
          nip46Log.warn('Stored payload parse error, generating new key');
        }
      } else {
        nip46Log.info('No stored payload, generating new local key');
      }

      this.signer = NDKNip46Signer.bunker(ndk, bunkerUri, localNsec);

      this.signer.on('authUrl', (url: string) => {
        nip46Log.info('Auth URL received:', url);
        window.open(url, '_blank', 'width=600,height=700');
      });

      const secret = this.signer.secret;
      const bunkerPubkey = this.signer.bunkerPubkey;

      nip46Log.info('Bunker config:', {
        bunkerPubkey: bunkerPubkey?.slice(0, 12) + '...',
        secret: secret ? secret.slice(0, 8) + '...' : 'none',
        relays: this.signer.relayUrls,
      });

      // Pre-set userPubkey to bunkerPubkey for hardware signers
      if (!this.signer.userPubkey && bunkerPubkey) {
        this.signer.userPubkey = bunkerPubkey;
      }

      // Set NIP-04 for the initial connect handshake (don't lock yet —
      // NDK's parseEvent needs to detect the response encryption format)
      this.signer.rpc.encryptionType = 'nip04';

      const localUser = await this.signer.localSigner.user();
      await this.signer.rpc.subscribe({
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
          nip46Log.info('Response received:', {
            id: response?.id,
            result: response?.result,
            error: response?.error,
          });

          if (response?.result === secret || response?.result === 'ack') {
            clearTimeout(timeout);
            nip46Log.info('Connect confirmed');
            resolve(bunkerPubkey!);
          } else if (response?.error) {
            clearTimeout(timeout);
            reject(new Error(response.error));
          }
        };

        this.signer!.rpc.on('response', responseHandler);

        this.signer!.rpc.sendRequest(
          bunkerPubkey!,
          'connect',
          [bunkerPubkey!, secret!],
          24133
        ).catch((err: any) => {
          nip46Log.error('sendRequest error:', err);
        });
      });

      const npub = hexToNpub(pubkey);
      if (!npub) {
        return { success: false, error: 'Failed to convert pubkey to npub' };
      }

      // Now lock encryptionType to NIP-04 for all subsequent operations
      // (prevents NDK auto-flip to nip44 which breaks hardware signers)
      this.lockEncryptionType(this.signer.rpc);

      // Activate pool for NDK auto-reconnection (same as restoreSession)
      this.activateRpcPool(this.signer.rpc);

      // Persist signer payload for session restore
      const signerPayload = this.signer.toPayload();
      localStorage.setItem(NIP46_STORAGE_KEY, signerPayload);

      nip46Log.info('Authentication successful');
      return { success: true, npub, pubkey };
    } catch (error: unknown) {
      this.signer = null;

      let errorMessage = 'Bunker authentication failed';
      if (error instanceof Error) {
        errorMessage = error.message;
      }

      nip46Log.error('Authentication failed:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }
}
