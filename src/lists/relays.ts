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

const logger = SystemLogger.getInstance();

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
 */
export async function fetchEvents(
  filters: NDKFilter[],
  timeoutMs: number = 5000
): Promise<NostrEvent[]> {
  const relays = getReadRelays();
  return await getTransport().fetch(relays, filters, timeoutMs);
}

/**
 * Publish event to relays
 */
export async function publishEvent(event: NostrEvent): Promise<Set<string>> {
  const relays = getWriteRelays();
  if (relays.length === 0) {
    throw new Error('No write relays available');
  }
  return await getTransport().publish(relays, event);
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

/**
 * Encrypt content for private items (NIP-44 with NIP-04 fallback)
 */
export async function encryptContent(plaintext: string, pubkey: string): Promise<string> {
  const authService = AuthService.getInstance();
  const authMethod = authService.getAuthMethod();

  if (authMethod === 'key-signer') {
    const { KeySignerClient } = await import('../services/KeySignerClient');
    const keySignerClient = KeySignerClient.getInstance();
    try {
      return await keySignerClient.nip44Encrypt(plaintext, pubkey);
    } catch {
      return await keySignerClient.nip04Encrypt(plaintext, pubkey);
    }
  } else if (authMethod === 'nip46') {
    const nip46Manager = (authService as any).nip46Manager;
    if (!nip46Manager?.isAvailable()) {
      throw new Error('NIP-46 remote signer not available');
    }
    try {
      return await withTimeout(() => nip46Manager.nip44Encrypt(plaintext, pubkey), 15000);
    } catch {
      return await withTimeout(() => nip46Manager.nip04Encrypt(plaintext, pubkey), 15000);
    }
  } else if (authMethod === 'extension') {
    try {
      if (window.nostr?.nip44?.encrypt) {
        return await window.nostr.nip44.encrypt(pubkey, plaintext);
      } else {
        throw new Error('NIP-44 not available');
      }
    } catch {
      if (window.nostr?.nip04?.encrypt) {
        return await window.nostr.nip04.encrypt(pubkey, plaintext);
      } else {
        throw new Error('No encryption support available in browser extension');
      }
    }
  } else {
    throw new Error(`Auth method not supported for encryption: ${authMethod}`);
  }
}

/**
 * Decrypt content from private items (NIP-44 with NIP-04 fallback)
 */
export async function decryptContent(ciphertext: string, senderPubkey: string): Promise<string | null> {
  const authService = AuthService.getInstance();
  const authMethod = authService.getAuthMethod();

  try {
    if (authMethod === 'key-signer') {
      const { KeySignerClient } = await import('../services/KeySignerClient');
      const keySignerClient = KeySignerClient.getInstance();
      try {
        return await keySignerClient.nip44Decrypt(ciphertext, senderPubkey);
      } catch {
        return await keySignerClient.nip04Decrypt(ciphertext, senderPubkey);
      }
    } else if (authMethod === 'nip46') {
      const nip46Manager = (authService as any).nip46Manager;
      if (!nip46Manager?.isAvailable()) {
        throw new Error('NIP-46 remote signer not available');
      }
      try {
        return await withTimeout(() => nip46Manager.nip44Decrypt(ciphertext, senderPubkey), 10000);
      } catch {
        return await withTimeout(() => nip46Manager.nip04Decrypt(ciphertext, senderPubkey), 10000);
      }
    } else if (authMethod === 'extension') {
      if (window.nostr?.nip44?.decrypt) {
        try {
          return await window.nostr.nip44.decrypt(senderPubkey, ciphertext);
        } catch { /* fall through to NIP-04 */ }
      }
      if (window.nostr?.nip04?.decrypt) {
        return await window.nostr.nip04.decrypt(senderPubkey, ciphertext);
      }
      return null;
    }
  } catch (error) {
    logger.error('relays.ts', `Decryption failed: ${error}`);
  }

  return null;
}

/**
 * Helper: wrap promise with timeout
 */
function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeoutMs)
    )
  ]);
}
