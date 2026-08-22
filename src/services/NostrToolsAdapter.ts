/**
 * NostrToolsAdapter
 * Compatibility layer for Nostr cryptographic operations
 *
 * @purpose Re-export Nostr functions for legacy code compatibility
 * @status 100% NDK-based migration
 *
 * ARCHITECTURE NOTE:
 * - All relay operations use NDK (NostrTransport.ts)
 * - Crypto functions imported from nostr-tools (NDK's peer dependency)
 * - NDK uses nostr-tools internally but doesn't re-export crypto functions
 * - This is NOT adding nostr-tools as OUR dependency - it's using NDK's
 */

import { nip19, type NostrEvent } from '@nostr-dev-kit/ndk';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

// Low-level crypto functions from nostr-tools (NDK's peer dependency)
// NDK uses these internally but doesn't expose them in public API
import {
  getPublicKey,
  finalizeEvent,
  verifyEvent,
  nip04,
  getEventHash,
  generateSecretKey,
  type UnsignedEvent as NostrToolsUnsignedEvent,
  type Event as NostrToolsEvent,
} from 'nostr-tools';
import type { DecodedResult } from 'nostr-tools/nip19';
import * as nip44 from 'nostr-tools/nip44';

// ============= TYPE EXPORTS =============

// Export nostr-tools UnsignedEvent as our UnsignedEvent
export type UnsignedEvent = NostrToolsUnsignedEvent;
export type { NostrEvent as Event };
export type { NDKFilter as Filter } from '@nostr-dev-kit/ndk';

// ============= BYTE CONVERSION =============

/**
 * Convert hex string to Uint8Array
 * Used for cryptographic operations
 */
export { hexToBytes };

/**
 * Convert Uint8Array to hex string
 * Used for cryptographic operations
 */
export { bytesToHex };

// ============= NIP-19 FUNCTIONS =============

/**
 * Decode any NIP-19 encoded string (npub/nsec/nevent/naddr/note)
 */
export function decodeNip19(encoded: string): DecodedResult {
  return nip19.decode(encoded) as DecodedResult;
}

/**
 * Encode hex pubkey to npub
 */
export function encodeNpub(pubkey: string): string {
  return nip19.npubEncode(pubkey);
}

/**
 * Encode event ID to nevent (with optional relay hints and author)
 */
export function encodeNevent(
  eventId: string,
  relays?: string[],
  author?: string
): string {
  return nip19.neventEncode({
    id: eventId,
    relays: relays || [],
    author,
  });
}

/**
 * Encode event ID to note1 (raw NIP-19 event id, no relay/author metadata).
 */
export function noteEncode(eventId: string): string {
  return nip19.noteEncode(eventId);
}

/**
 * Encode long-form content address to naddr
 */
export function encodeNaddr(params: {
  pubkey: string;
  kind: number;
  identifier: string;
  relays?: string[];
}): string {
  return nip19.naddrEncode({
    pubkey: params.pubkey,
    kind: params.kind,
    identifier: params.identifier,
    relays: params.relays || [],
  });
}

/**
 * Encode hex private key to nsec
 */
export function encodeNsec(privateKey: string): string {
  return nip19.nsecEncode(hexToBytes(privateKey));
}

// ============= EVENT SIGNING =============

/**
 * Derive public key from private key
 */
export function getPublicKeyFromPrivate(privateKeyHex: string): string {
  return getPublicKey(hexToBytes(privateKeyHex));
}

/**
 * Calculate event hash (ID)
 */
export function calculateEventHash(event: UnsignedEvent): string {
  return getEventHash(event);
}

/**
 * Sign event with private key
 */
export function signEventWithKey(
  event: UnsignedEvent,
  privateKeyHex: string
): string {
  const signedEvent = finalizeEvent(event, hexToBytes(privateKeyHex));
  return signedEvent.sig;
}

/**
 * Verify event signature
 */
export function verifyEventSignature(event: NostrEvent): boolean {
  return verifyEvent(event as NostrToolsEvent);
}

/**
 * Complete event signing: adds pubkey, id, and sig
 */
export function finalizeEventSigning(
  event: UnsignedEvent,
  privateKeyHex: string,
  _pubkey?: string
): NostrEvent {
  return finalizeEvent(event, hexToBytes(privateKeyHex)) as NostrEvent;
}

// ============= NIP-04 & NIP-47 (NWC) =============

/**
 * Re-export finalizeEvent for event signing
 * Used by NWCService and ZapService
 */
export { finalizeEvent };

/**
 * Re-export nip04 for NIP-04 encryption/decryption
 * Used by NWCService for encrypted wallet communication
 */
export { nip04 };

/**
 * Re-export generateSecretKey for creating ephemeral keys
 * Used by DMService for Gift Wrap
 */
export { generateSecretKey };

/**
 * Re-export getPublicKey for deriving public keys
 * Used by DMService for ephemeral keys
 */
export { getPublicKey };

// ============= NIP-44 ENCRYPTION =============

/**
 * NIP-44 encrypt plaintext for a recipient
 * @param plaintext - Text to encrypt
 * @param recipientPubkey - Recipient's public key (hex)
 * @param privateKey - Sender's private key (hex)
 * @returns Encrypted payload
 */
export function nip44Encrypt(
  plaintext: string,
  recipientPubkey: string,
  privateKey: string
): string {
  const conversationKey = nip44.getConversationKey(
    hexToBytes(privateKey),
    recipientPubkey
  );
  return nip44.encrypt(plaintext, conversationKey);
}

/**
 * NIP-44 decrypt ciphertext from a sender
 * @param ciphertext - Encrypted payload
 * @param senderPubkey - Sender's public key (hex)
 * @param privateKey - Recipient's private key (hex)
 * @returns Decrypted plaintext
 */
export function nip44Decrypt(
  ciphertext: string,
  senderPubkey: string,
  privateKey: string
): string {
  const conversationKey = nip44.getConversationKey(
    hexToBytes(privateKey),
    senderPubkey
  );
  return nip44.decrypt(ciphertext, conversationKey);
}

/**
 * NIP-44 decrypt with a pre-derived conversation key (symmetric usage).
 *
 * Concord's CORD-05 invite bundles (kind 33301) reuse the NIP-44 ciphertext
 * format but skip the DH step: both sides already share a 32-byte symmetric
 * key derived via HKDF from the invite's unlock token. This wrapper takes
 * that key directly as the conversation key.
 *
 * @param ciphertext - Encrypted payload (NIP-44 v2 format)
 * @param conversationKey - 32-byte pre-derived symmetric key (Uint8Array)
 * @returns Decrypted plaintext
 */
export function nip44DecryptWithKey(
  ciphertext: string,
  conversationKey: Uint8Array
): string {
  return nip44.decrypt(ciphertext, conversationKey);
}

/**
 * NIP-44 conversation key from a private key + public key (hex strings).
 * Used by Concord V2 stream keys: `getConversationKey(streamSk, streamPk)`
 * produces the self-ECDH key that encrypts a channel's gift wraps.
 */
export function nip44ConversationKey(
  privateKey: string,
  publicKey: string
): Uint8Array {
  return nip44.getConversationKey(hexToBytes(privateKey), publicKey);
}
