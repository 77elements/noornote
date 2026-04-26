/**
 * NostrConnectSignerManager
 * Handles nostrconnect:// QR-based login via NIP-46.
 * Isolated from Bunker URL flow — each has its own signer lifecycle.
 *
 * Uses 2 parallel relays for redundancy.
 * NDK's RPC pool publishes to both and subscribes on both — if one relay
 * goes down, communication continues via the other.
 */

import { NDKNip46Signer } from '@nostr-dev-kit/ndk';
import { hexToNpub } from '../../helpers/nip19';
import { Nip46BaseManager, NIP46_STORAGE_KEY, nip46Log, type Nip46AuthResult, type NostrConnectSession } from './Nip46BaseManager';

/** NIP-46 relays for the nostrconnect flow (parallel multi-relay) */
const NIP46_RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.damus.io',
];

export class NostrConnectSignerManager extends Nip46BaseManager {

  /**
   * Start a nostrconnect:// flow.
   * Generates URI for QR display and returns a listener
   * that resolves when a remote signer connects.
   */
  public async startNostrConnect(): Promise<NostrConnectSession> {
    const { NostrTransport } = await import('../transport/NostrTransport');
    const ndk = NostrTransport.getInstance().getNDK();

    nip46Log.info('Starting nostrconnect flow, relays:', NIP46_RELAYS.join(', '));

    // Create signer with all relays (RPC pool connects to all)
    const signer = new NDKNip46Signer(ndk, undefined, undefined, NIP46_RELAYS, {
      name: 'NoorNote',
      url: 'https://noornote.app'
    });
    this.signer = signer;

    // NDK only puts the first relay in the URI — add the rest
    // so the remote signer (Amber) subscribes on all relays too
    let uri = signer.nostrConnectUri!;
    for (let i = 1; i < NIP46_RELAYS.length; i++) {
      uri += `&relay=${encodeURIComponent(NIP46_RELAYS[i]!)}`;
    }

    let cancelled = false;
    let connected = false;
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
          this.stopSignerAndPool(signer);
          this.signer = null;
          return { success: false, error: 'Cancelled' };
        }

        const pubkey = user.pubkey;
        const npub = hexToNpub(pubkey);

        if (!npub) {
          this.stopSignerAndPool(signer);
          this.signer = null;
          return { success: false, error: 'Failed to convert pubkey to npub' };
        }

        // Lock NIP-04 for the RPC layer after nostrconnect handshake
        this.lockEncryptionType(signer.rpc);

        // Activate pool for NDK auto-reconnection
        this.activateRpcPool(signer.rpc);

        const signerPayload = signer.toPayload();
        localStorage.setItem(NIP46_STORAGE_KEY, signerPayload);

        connected = true;
        nip46Log.info('nostrconnect successful');
        return { success: true, npub, pubkey };
      } catch (error) {
        if (cancelled) return { success: false, error: 'Cancelled' };
        this.stopSignerAndPool(signer);
        this.signer = null;
        const msg = error instanceof Error ? error.message : String(error);
        nip46Log.error('nostrconnect failed:', msg);
        return { success: false, error: msg };
      }
    };

    const cancel = () => {
      if (connected) return;
      cancelled = true;
      cancelReject?.();
      this.stopSignerAndPool(signer);
      this.signer = null;
    };

    return { uri, waitForConnection, cancel };
  }
}
