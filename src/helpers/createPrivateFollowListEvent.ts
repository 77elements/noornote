/**
 * Create a NIP-51 kind 30000 private follow list event
 *
 * NIP-51 Spec:
 * - kind: 30000 (Categorized People List)
 * - d tag: 'private-follows' (identifier for private follow list)
 * - p tags: encrypted array of followed pubkeys
 * - content: empty or optional description
 *
 * @param authorPubkey - Author's public key
 * @param privateFollows - Array of pubkeys to store privately
 * @returns Unsigned kind 30000 event ready for signing
 *
 * @example
 * const unsignedEvent = await createPrivateFollowListEvent(
 *   myPubkey,
 *   ['abc123...', 'def456...']
 * );
 */

import { encryptPrivateFollows } from './encryptPrivateFollows';

export async function createPrivateFollowListEvent(
  authorPubkey: string,
  privateFollows: string[]
): Promise<{
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  pubkey: string;
}> {
  // Encrypt the private follow list
  const encryptedContent =
    privateFollows.length > 0
      ? await encryptPrivateFollows(privateFollows, authorPubkey)
      : '';

  // Build kind 30000 event
  return {
    kind: 30000,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', 'private-follows'], // NIP-51 identifier for this list
    ],
    content: encryptedContent, // Encrypted private follows
    pubkey: authorPubkey,
  };
}
