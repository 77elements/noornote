/**
 * Armada / Concord encrypted community invite types.
 *
 * Shared across parseArmadaInvite, decodeInviteFragment, decodeInviteBundle
 * and decryptArmadaImage. See CORD-05 (Concord's invite spec) for the wire
 * format — kind 33301 addressable invite bundles whose content is NIP-44
 * encrypted under a key derived from the URL's `#fragment`.
 */

/** The addressable invite-bundle kind (Concord CORD-05 §1). */
export const INVITE_BUNDLE_KIND = 33301;

/** Web app that can open these invites. */
export const ARMADA_INVITE_BASE = 'https://armada.buzz/invite/';

/** Decode a parsed invite (URL or bare naddr#fragment). */
export interface ArmadaInvite {
  /** The bare invite-bundle naddr (locator, no fragment). */
  naddr: string;
  /** The link signer's pubkey (hex) — the bundle coordinate's author. */
  linkSigner: string;
  /** The `#fragment` secret, without the leading `#`. Empty if absent. */
  fragment: string;
  /** Canonical https URL that opens the invite in Armada. */
  openUrl: string;
  /** True when the link is missing its `#fragment` and therefore can't be joined or decrypted. */
  missingSecret: boolean;
}

/** Encrypted-blob pointer (icon) — the media host stores AES-256-GCM ciphertext. */
export interface ArmadaImagePointer {
  url: string;
  /** Hex AES-256-GCM key. */
  key: string;
  /** Hex AES-GCM nonce/IV. */
  nonce: string;
  /** Hex SHA-256 of the plaintext (integrity check). */
  hash: string;
}

/** A channel's on-wire identity as carried by the invite bundle. */
export interface ArmadaChannel {
  /** 64-char hex channel id — input to channelGroupKey derivation. */
  id: string;
  /** Channel name (display only). */
  name?: string;
  /** Channel epoch — input to channelGroupKey derivation. */
  epoch: number;
}

/** The decrypted invite bundle's public preview fields (CORD-05 §1). */
export interface ArmadaInvitePreview {
  name: string;
  icon?: ArmadaImagePointer;
  channelCount: number;
  /** Bootstrap relays carried by the bundle (post-join, informational). */
  relays: string[];
  /** True once past the bundle's optional `expires_at`. */
  expired: boolean;
  /** Community root key (64-char hex) — needed for GroupKey derivation. */
  communityRoot?: string;
  /** Root epoch for public channels. */
  rootEpoch?: number;
  /** Community ID (64-char hex) — self-certifying identity from bundle. */
  communityId?: string;
  /** Channel identities (id + epoch per channel, needed for GroupKey derivation). */
  channels?: ArmadaChannel[];
}
