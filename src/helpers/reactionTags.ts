/**
 * NIP-25 reaction tag builder — pure, shared by ReactionService.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { getAddressableIdentifier } from './getAddressableIdentifier';

/**
 * Build the NIP-25 tag set for a kind:7 reaction.
 *
 * Branches:
 * - Addressable targets (kind 30000–39999): `e` (hex event id) + `a`
 *   (coordinate) + `k` + `p`. The legacy code path passes the addressable
 *   identifier ("kind:pubkey:dtag") as `noteId` — NOT valid 32-byte hex;
 *   strict relays reject it, hence the hex event id from `targetEvent`.
 * - Reaction-on-reaction (kind 7 → kind 7): `e` + `k:7` + `p` — the k marker
 *   lets readers build the tree without resolving the parent event first.
 * - Reaction-on-zap (kind 7 → kind 9735): `e` + `k:9735` + `p`. The p-tag
 *   points at the ZAP SENDER (passed as `authorPubkey`), not at the receipt
 *   author (wallet/LNURL server) — "reacted to your zap" is about the sender
 *   (field-verified convention). For anonymous receipts callers pass the
 *   receipt's p-tag (recipient) as fallback.
 * - Default: `e` + `p`.
 */
export function buildReactionTags(
  noteId: string,
  authorPubkey: string,
  targetEvent?: NostrEvent
): string[][] {
  const tags: string[][] = [];
  const isAddressable =
    targetEvent?.kind !== undefined &&
    targetEvent.kind >= 30000 &&
    targetEvent.kind < 40000 &&
    !!targetEvent.id;

  if (isAddressable && targetEvent && targetEvent.id) {
    const addressableId = getAddressableIdentifier(targetEvent);
    tags.push(['e', targetEvent.id]);
    if (addressableId) tags.push(['a', addressableId]);
    tags.push(['k', String(targetEvent.kind)]);
    tags.push(['p', authorPubkey]);
  } else if (targetEvent?.kind === 7 && targetEvent.id) {
    tags.push(['e', targetEvent.id]);
    tags.push(['k', '7']);
    tags.push(['p', authorPubkey]);
  } else if (targetEvent?.kind === 9735 && targetEvent.id) {
    tags.push(['e', targetEvent.id]);
    tags.push(['k', '9735']);
    tags.push(['p', authorPubkey]);
  } else {
    tags.push(['e', noteId]);
    tags.push(['p', authorPubkey]);
  }

  return tags;
}
