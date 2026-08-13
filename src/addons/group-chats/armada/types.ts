/**
 * Tracked Armada community — one entry per invite the user has added to
 * NoorNote's community registry. Stored as a map (`naddr → TrackedCommunity`)
 * in PerAccountLocalStorage; small enough that IndexedDB is overkill here
 * (Sprint 3+ message storage will get its own IndexedDB when needed).
 *
 * The `fragment` is the CORD-05 unlock secret from the invite URL. It is
 * REQUIRED to decrypt the bundle AND the community's gift-wrapped messages
 * — without it, the community can't be polled. Storing it locally is the
 * user's explicit choice (they pasted the invite link), and it never leaves
 * the device (we fetch ciphertext from relays, decrypt locally).
 */

import type { ArmadaImagePointer } from '../../../helpers/armada/types';

export interface TrackedCommunity {
  /** Bare invite-bundle naddr (kind 33301, d=""). Primary key in the registry. */
  naddr: string;
  /** Bundle author pubkey (hex) — identifies the community. */
  linkSigner: string;
  /** CORD-05 unlock fragment (base64url, without leading `#`). Required for decrypt. */
  fragment: string;
  /** Decrypted community name from the bundle preview. */
  name: string;
  /** Encrypted icon pointer (if the bundle provided one). */
  iconPointer?: ArmadaImagePointer;
  /** Channel count from the bundle preview. */
  channelCount: number;
  /** Bootstrap relays decoded from the fragment (always host the bundle). */
  bootstrapRelays: string[];
  /** Canonical armada.buzz invite URL (with fragment) for the "Open in Armada" action. */
  openUrl: string;
  /** Unix timestamp (ms) when the user added this community. */
  addedAt: number;
  /** Unix timestamp (seconds) of the last successful poll. Undefined until first poll. */
  lastCheckedAt?: number;
}
