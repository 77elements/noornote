/**
 * Concord crypto helpers — community key derivation + gift-wrap decrypt.
 *
 * ARCHITECTURE NOTE (verified against live Armada traffic, Aug 2026):
 *
 * Concord uses TWO separate encryption layers:
 *
 *   1. **Invite bundle** (kind 33301 content) — encrypted with the COMMUNITY
 *      SHARED KEY derived from the invite token via HKDF. This key is the
 *      same for all members. Used for: bundle metadata (name, icon, channels).
 *      → `deriveCommunityKey()` + `nip44DecryptWithKey()` handle this.
 *
 *   2. **Community messages** (kind 1059 gift wraps) — standard NIP-59
 *      per-recipient wrapping. Each member gets an individually-wrapped copy
 *      addressed to their own pubkey (`#p` tag). The inner seal+rumor are
 *      encrypted with ECDH between the ephemeral wrap key and the recipient.
 *      → Standard `AuthService.nip44Decrypt` handles this (same pipeline as
 *        DMService.unwrapGiftWrap). No community key involved.
 *
 * This means Sprint 4's polling does NOT use `decryptCommunityGiftWrap` for
 * regular messages — it fetches wraps via `#p: [userPubkey]` and unwraps them
 * using AuthService. The `decryptCommunityGiftWrap` function below is kept
 * for potential future use (admin events, role rosters, or other Concord
 * event types that MIGHT use the shared key — unverified as of v1.3.4).
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { nip44DecryptWithKey } from '../../../services/NostrToolsAdapter';
import { decodeInviteFragment } from '../../../helpers/armada/decodeInviteFragment';
import { inviteBundleKey } from '../../../helpers/armada/decodeInviteBundle';

const KIND_GIFT_WRAP = 1059;
const KIND_SEAL = 13;

/**
 * Derive the community shared key from a CORD-05 invite fragment.
 * Used for: invite bundle decryption (metadata: name, icon, channels).
 * NOT used for: regular community messages (those use standard NIP-59).
 *
 * Returns undefined if the fragment can't be decoded.
 */
export function deriveCommunityKey(fragment: string): Uint8Array | undefined {
  const decoded = decodeInviteFragment(fragment);
  if (!decoded?.token) return undefined;
  return inviteBundleKey(decoded.token);
}

/**
 * Decrypt a Concord gift-wrapped event using the COMMUNITY SHARED KEY.
 *
 * ⚠️ This is for the SHARED-KEY encryption path (bundle-style). Regular
 * community messages use STANDARD NIP-59 per-recipient wrapping instead —
 * see the architecture note above. Sprint 4's polling uses AuthService for
 * per-recipient unwrapping, not this function.
 *
 * Pipeline (shared-key variant):
 *   1. nip44DecryptWithKey(wrap.content, communityKey) → seal JSON (kind 13)
 *   2. nip44DecryptWithKey(seal.content, communityKey) → rumor JSON
 *   3. Anti-spoofing: rumor.pubkey === seal.pubkey
 *
 * Returns the rumor on success, or null on any failure.
 */
export function decryptCommunityGiftWrap(
  wrapEvent: NostrEvent,
  communityKey: Uint8Array,
): NostrEvent | null {
  if (wrapEvent.kind !== KIND_GIFT_WRAP) return null;

  try {
    const sealJson = nip44DecryptWithKey(wrapEvent.content, communityKey);
    const seal = JSON.parse(sealJson) as NostrEvent;
    if (seal.kind !== KIND_SEAL) return null;

    const rumorJson = nip44DecryptWithKey(seal.content, communityKey);
    const rumor = JSON.parse(rumorJson) as NostrEvent;

    if (rumor.pubkey !== seal.pubkey) return null;

    return rumor;
  } catch {
    return null;
  }
}
