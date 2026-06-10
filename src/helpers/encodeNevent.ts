/**
 * Encode event ID and relay hints into nevent (NIP-19)
 * Single purpose: (eventId, relays, author) → nostr:nevent string
 *
 * @param eventId - Hex event ID to encode
 * @param relays - Relay hints array
 * @param authorPubkey - Author pubkey
 * @returns nostr:nevent string with relay hints
 *
 * @example
 * encodeNevent("abc123...", ["wss://relay.example.com"], "author123...")
 * // => "nostr:nevent1qqsabc123..."
 */

import { encodeNevent as adapterEncodeNevent } from '../services/NostrToolsAdapter';

export function encodeNevent(
  eventId: string,
  relays: string[],
  authorPubkey: string
): string {
  const nevent = adapterEncodeNevent(eventId, relays, authorPubkey);
  return `nostr:${nevent}`;
}
