/**
 * NIP-19: Bech32-encoded entities
 * Centralized module for all NIP-19 encoding/decoding operations
 *
 * @module nip19
 * @see https://github.com/nostr-protocol/nips/blob/master/19.md
 */

import { decodeNip19, encodeNpub } from '../services/NostrToolsAdapter';
import { bech32 } from 'bech32';

/**
 * Convert npub to hex pubkey
 *
 * @param npub - Bech32-encoded public key (npub1...)
 * @returns Hex pubkey or null if invalid
 *
 * @example
 * npubToHex("npub1...")
 * // => "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"
 */
export function npubToHex(npub: string): string | null {
  try {
    const decoded = decodeNip19(npub);
    if (decoded.type === 'npub') {
      return decoded.data as string;
    }
    return null;
  } catch (error) {
    console.warn('Failed to decode npub:', npub, error);
    return null;
  }
}

/**
 * Convert hex pubkey to npub
 *
 * @param hex - Hex-encoded public key
 * @returns Bech32-encoded npub or null if invalid
 *
 * @example
 * hexToNpub("3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d")
 * // => "npub1..."
 */
export function hexToNpub(hex: string): string | null {
  try {
    return encodeNpub(hex);
  } catch (error) {
    console.warn('Failed to encode hex to npub:', hex, error);
    return null;
  }
}

/**
 * Convert hex private key to nsec (bech32) format
 *
 * @param hex - Hex-encoded private key
 * @returns Bech32-encoded nsec
 *
 * @example
 * hexToNsec("...")
 * // => "nsec1..."
 */
export function hexToNsec(hex: string): string {
  const data = Buffer.from(hex, 'hex');
  const words = bech32.toWords(data);
  return bech32.encode('nsec', words, 1000);
}

/**
 * Convert nprofile to npub
 * Extracts pubkey from nprofile (which includes relay hints) and converts to npub
 *
 * @param nprofile - Bech32-encoded profile pointer (nprofile1...)
 * @returns Bech32-encoded npub
 * @throws Error if input is not a valid nprofile
 *
 * @example
 * nprofileToNpub("nprofile1...")
 * // => "npub1..."
 */
export function nprofileToNpub(nprofile: string): string {
  const decoded = decodeNip19(nprofile);

  if (decoded.type === 'nprofile') {
    // nprofile contains pubkey (hex) - convert to npub
    // decoded.data is ProfilePointer { pubkey: string, relays?: string[] }
    const pubkeyHex = (decoded.data as any).pubkey;
    return encodeNpub(pubkeyHex);
  }

  throw new Error(`Expected nprofile, got ${decoded.type}`);
}

/**
 * Extract all npub/nprofile identifiers from text and convert to hex pubkeys
 * Supports both with and without "nostr:" prefix
 *
 * @param text - Text containing npub/nprofile identifiers
 * @returns Array of unique hex pubkeys
 *
 * @example
 * extractPubkeysFromText("Follow @alice nostr:npub1abc... and npub1xyz...")
 * // => ["<hex1>", "<hex2>"]
 */
export function extractPubkeysFromText(text: string): string[] {
  // Match npub and nprofile with or without "nostr:" prefix
  const nip19Regex = /(?:nostr:)?(npub1[023456789acdefghjklmnpqrstuvwxyz]{58}|nprofile1[023456789acdefghjklmnpqrstuvwxyz]{58,})/g;
  const matches = text.matchAll(nip19Regex);
  const pubkeys = new Set<string>();

  for (const match of matches) {
    try {
      const nip19 = match[1]; // Capture group without "nostr:" prefix

      if (nip19.startsWith('npub')) {
        const hex = npubToHex(nip19);
        if (hex) pubkeys.add(hex);
      } else if (nip19.startsWith('nprofile')) {
        const decoded = decodeNip19(nip19);
        if (decoded.type === 'nprofile') {
          const pubkeyHex = (decoded.data as any).pubkey;
          pubkeys.add(pubkeyHex);
        }
      }
    } catch (error) {
      console.warn('Failed to decode NIP-19 identifier:', match[1], error);
    }
  }

  return Array.from(pubkeys);
}
