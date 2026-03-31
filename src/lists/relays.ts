/**
 * relays.ts - Shared relay fetch/publish for all lists
 *
 * Wraps NostrTransport for list-specific relay operations.
 * Provides fetch and publish methods with encryption support.
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { NostrTransport } from '../services/transport/NostrTransport';
import { RelayConfig } from '../services/RelayConfig';
import { AuthService } from '../services/AuthService';
import { SystemLogger } from '../components/system/SystemLogger';
import { diagLog } from '../services/DiagnosticLogger';

const logger = SystemLogger.getInstance();
const NIP46_TIMEOUT_MS = 15000;

/**
 * Get transport instance
 */
export function getTransport(): NostrTransport {
  return NostrTransport.getInstance();
}

/**
 * Get aggregator relays for fetching
 */
export function getReadRelays(): string[] {
  return RelayConfig.getInstance().getAggregatorRelays();
}

/**
 * Get write relays for publishing
 */
export function getWriteRelays(): string[] {
  return getTransport().getWriteRelays();
}

/**
 * Get current user's pubkey
 */
export function getCurrentUserPubkey(): string | null {
  const user = AuthService.getInstance().getCurrentUser();
  return user?.pubkey || null;
}

/**
 * Require authenticated user (throws if not logged in)
 */
export function requireAuth(): { pubkey: string } {
  const user = AuthService.getInstance().getCurrentUser();
  if (!user) {
    throw new Error('User not authenticated');
  }
  return user;
}

/**
 * Fetch events from relays
 * @param skipCache - If true, bypass NDK cache and fetch fresh from relays (use for sync operations)
 */
export async function fetchEvents(
  filters: NDKFilter[],
  timeoutMs: number = 5000,
  skipCache: boolean = false
): Promise<NostrEvent[]> {
  const relays = getReadRelays();
  return await getTransport().fetch(relays, filters, timeoutMs, skipCache);
}

/**
 * Publish event to relays
 */
export async function publishEvent(event: NostrEvent): Promise<Set<string>> {
  const relays = getWriteRelays();
  if (relays.length === 0) {
    throw new Error('No write relays available');
  }
  const confirmedRelays = await getTransport().publish(relays, event);
  return confirmedRelays;
}

/**
 * Sign an event using AuthService
 */
export async function signEvent(event: {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  pubkey: string;
}): Promise<NostrEvent | null> {
  return await AuthService.getInstance().signEvent(event);
}

// ===== Encryption =====

type EncryptFn = (plaintext: string, pubkey: string) => Promise<string>;
type DecryptFn = (ciphertext: string, pubkey: string) => Promise<string>;

/**
 * Try NIP-44 encryption first, fall back to NIP-04
 */
async function tryEncryptWithFallback(
  nip44Fn: EncryptFn,
  nip04Fn: EncryptFn,
  plaintext: string,
  pubkey: string
): Promise<string> {
  try {
    const result = await nip44Fn(plaintext, pubkey);
    diagLog('relays', 'tryEncryptWithFallback: NIP-44 succeeded', { ciphertextLength: result.length });
    return result;
  } catch (nip44Error) {
    diagLog('relays', 'tryEncryptWithFallback: NIP-44 failed, falling back to NIP-04', { error: String(nip44Error) });
    const result = await nip04Fn(plaintext, pubkey);
    diagLog('relays', 'tryEncryptWithFallback: NIP-04 succeeded', { ciphertextLength: result.length });
    return result;
  }
}

/**
 * Try NIP-44 decryption first, fall back to NIP-04
 */
async function tryDecryptWithFallback(
  nip44Fn: DecryptFn | undefined,
  nip04Fn: DecryptFn | undefined,
  ciphertext: string,
  pubkey: string
): Promise<string | null> {
  if (nip44Fn) {
    try {
      const result = await nip44Fn(ciphertext, pubkey);
      diagLog('relays', 'tryDecryptWithFallback: NIP-44 succeeded', { plaintextLength: result.length });
      return result;
    } catch (nip44Error) {
      diagLog('relays', 'tryDecryptWithFallback: NIP-44 failed, trying NIP-04', { error: String(nip44Error) });
    }
  }
  if (nip04Fn) {
    const result = await nip04Fn(ciphertext, pubkey);
    diagLog('relays', 'tryDecryptWithFallback: NIP-04 succeeded', { plaintextLength: result.length });
    return result;
  }
  diagLog('relays', 'tryDecryptWithFallback: no decrypt function available, returning null');
  return null;
}

/**
 * Get NIP-46 manager from AuthService
 */
function getNip46Manager(): import('../services/managers/Nip46BaseManager').Nip46BaseManager {
  const authService = AuthService.getInstance();
  const nip46Manager = authService.nip46Manager;
  if (!nip46Manager?.isAvailable()) {
    throw new Error('NIP-46 remote signer not available');
  }
  return nip46Manager;
}

/**
 * Encrypt content for private items (NIP-44 with NIP-04 fallback)
 */
export async function encryptContent(plaintext: string, pubkey: string): Promise<string> {
  const authMethod = AuthService.getInstance().getAuthMethod();
  diagLog('relays', 'encryptContent', { authMethod, plaintextLength: plaintext.length });

  if (authMethod === 'key-signer') {
    const { KeySignerClient } = await import('../services/KeySignerClient');
    const client = KeySignerClient.getInstance();
    return tryEncryptWithFallback(
      (p, k) => client.nip44Encrypt(p, k),
      (p, k) => client.nip04Encrypt(p, k),
      plaintext,
      pubkey
    );
  }

  if (authMethod === 'nip46') {
    const manager = getNip46Manager();
    return tryEncryptWithFallback(
      (p, k) => withTimeout(() => manager.nip44Encrypt(p, k), NIP46_TIMEOUT_MS),
      (p, k) => withTimeout(() => manager.nip04Encrypt(p, k), NIP46_TIMEOUT_MS),
      plaintext,
      pubkey
    );
  }

  if (authMethod === 'extension') {
    if (window.nostr?.nip44?.encrypt) {
      try {
        return await window.nostr.nip44.encrypt(pubkey, plaintext);
      } catch {
        // Fall through to NIP-04
      }
    }
    if (window.nostr?.nip04?.encrypt) {
      return await window.nostr.nip04.encrypt(pubkey, plaintext);
    }
    throw new Error('No encryption support available in browser extension');
  }

  throw new Error(`Auth method not supported for encryption: ${authMethod}`);
}

/**
 * Decrypt content from private items (NIP-44 with NIP-04 fallback)
 */
export async function decryptContent(ciphertext: string, senderPubkey: string): Promise<string | null> {
  const authService = AuthService.getInstance();
  if (authService.isBunkerAuth()) {
    diagLog('relays', 'decryptContent: skipping — bunker auth has no decryption support');
    return null;
  }
  const authMethod = authService.getAuthMethod();
  diagLog('relays', 'decryptContent', { authMethod, ciphertextLength: ciphertext.length, isNip04: ciphertext.includes('?iv=') });

  try {
    if (authMethod === 'key-signer') {
      const { KeySignerClient } = await import('../services/KeySignerClient');
      const client = KeySignerClient.getInstance();
      return await tryDecryptWithFallback(
        (c, k) => client.nip44Decrypt(c, k),
        (c, k) => client.nip04Decrypt(c, k),
        ciphertext,
        senderPubkey
      );
    }

    if (authMethod === 'nip46') {
      const manager = getNip46Manager();
      return await tryDecryptWithFallback(
        (c, k) => withTimeout(() => manager.nip44Decrypt(c, k), NIP46_TIMEOUT_MS),
        (c, k) => withTimeout(() => manager.nip04Decrypt(c, k), NIP46_TIMEOUT_MS),
        ciphertext,
        senderPubkey
      );
    }

    if (authMethod === 'extension') {
      return await tryDecryptWithFallback(
        window.nostr?.nip44?.decrypt
          ? (c, k) => window.nostr!.nip44!.decrypt(k, c)
          : undefined,
        window.nostr?.nip04?.decrypt
          ? (c, k) => window.nostr!.nip04!.decrypt(k, c)
          : undefined,
        ciphertext,
        senderPubkey
      );
    }
  } catch (error) {
    diagLog('relays', 'decryptContent: FAILED', { error: String(error) });
    logger.error('relays.ts', `Decryption failed: ${error}`);
  }

  diagLog('relays', 'decryptContent: returning null (no supported auth method or all attempts failed)');
  return null;
}

/**
 * Wrap promise with timeout
 */
function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeoutMs)
    )
  ]);
}
