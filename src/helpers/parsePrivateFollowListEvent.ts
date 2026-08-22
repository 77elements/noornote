/**
 * Parse a NIP-51 kind 30000 private follow list event
 *
 * Decrypts and extracts the list of privately followed pubkeys
 *
 * @param event - kind 30000 event from relay
 * @param authorPubkey - Author's pubkey (for decryption)
 * @returns Array of privately followed pubkeys
 *
 * @example
 * const privateFollows = await parsePrivateFollowListEvent(event, myPubkey);
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { decryptPrivateFollows } from './decryptPrivateFollows';

export async function parsePrivateFollowListEvent(
  event: NostrEvent,
  authorPubkey: string
): Promise<string[]> {
  // Validate event kind
  if (event.kind !== 30000) {
    throw new Error(`Invalid event kind: expected 30000, got ${event.kind}`);
  }

  // Validate d tag
  const dTag = event.tags.find(tag => tag[0] === 'd');
  if (!dTag || dTag[1] !== 'private-follows') {
    throw new Error('Invalid d tag: expected "private-follows"');
  }

  // Decrypt content
  if (!event.content || event.content.trim() === '') {
    return []; // Empty list
  }

  try {
    const privateFollows = await decryptPrivateFollows(
      event.content,
      authorPubkey
    );
    return privateFollows;
  } catch (error) {
    console.error('Failed to parse private follow list event:', error);
    return []; // Fail gracefully
  }
}
