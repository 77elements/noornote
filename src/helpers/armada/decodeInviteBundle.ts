/**
 * Decode an Armada invite bundle (kind 33301) into its public preview.
 *
 * Ported from Ditto's lib/armadaInvite.ts (decodeInviteBundle + inviteBundleKey).
 *
 * The bundle is a NIP-01 addressable event at coordinate
 * `(kind 33301, link_signer, d="")`. Its `content` is NIP-44-encrypted JSON
 * carrying the public preview (name, icon, channels, relays, optional
 * expiry). The encryption key is HKDF-SHA256 with:
 *   - input keying material: the 16-byte unlock token from the URL fragment
 *   - salt: zero bytes (none)
 *   - info: `b"concord/invite-key" || 0x00 || ZERO32`
 *
 * The `vsk` tag must equal `"6"` (live) — anything else means revoked or
 * unknown, in which case we bail and the caller renders the static fallback.
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import {
  nip44DecryptWithKey,
  verifyEventSignature,
} from '../../services/NostrToolsAdapter';
import { getTag } from '../tagUtils';
import {
  INVITE_BUNDLE_KIND,
  type ArmadaChannel,
  type ArmadaImagePointer,
  type ArmadaInvitePreview,
} from './types';

const MAX_BOOTSTRAP_RELAYS = 3;
const VSK_INVITE_LIVE = '6';

/**
 * The public-invite bundle decrypt key, derived from the link's unlock token
 * (Concord derive.ts §A): `HKDF-SHA256(token, info="concord/invite-key"‖0x00‖ZERO32)`.
 *
 * Exported so the Armada addon's gift-wrap decryptor can reuse the SAME key
 * (Concord shares one key across bundle + gift wraps + seals — "key
 * possession = membership").
 */
export function inviteBundleKey(token: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode('concord/invite-key');
  const info = new Uint8Array(label.length + 1 + 32); // label ‖ 0x00 ‖ 32-byte zero id
  info.set(label, 0);
  return hkdf(sha256, token, new Uint8Array(0), info, 32);
}

function isImagePointer(v: unknown): v is ArmadaImagePointer {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.url === 'string' &&
    typeof o.key === 'string' &&
    typeof o.nonce === 'string' &&
    typeof o.hash === 'string'
  );
}

/**
 * Verify + decrypt a fetched invite-bundle event into its public preview.
 *
 * `expectedSigner` is the naddr's author; we re-check the signature/author to
 * reject a relay handing back garbage. Returns undefined for a tombstone, a
 * bad signature, a wrong author, a revoked/unknown `vsk`, or a token that
 * doesn't decrypt. The caller falls back to the static "Encrypted community"
 * card with an "Open in Armada" button.
 */
export function decodeInviteBundle(
  event: NostrEvent,
  expectedSigner: string,
  token: Uint8Array
): ArmadaInvitePreview | undefined {
  if (event.kind !== INVITE_BUNDLE_KIND) return undefined;
  if (event.pubkey !== expectedSigner) return undefined;
  const vsk = getTag(event.tags, 'vsk');
  if (vsk !== VSK_INVITE_LIVE) return undefined; // revoked or unknown marker
  if (
    !verifyEventSignature(event as Parameters<typeof verifyEventSignature>[0])
  )
    return undefined;

  let bundle: Record<string, unknown>;
  try {
    bundle = JSON.parse(
      nip44DecryptWithKey(event.content, inviteBundleKey(token))
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!bundle || typeof bundle !== 'object') return undefined;

  const name = typeof bundle.name === 'string' ? bundle.name : '';
  const channelsRaw = Array.isArray(bundle.channels) ? bundle.channels : [];
  const relays = Array.isArray(bundle.relays)
    ? bundle.relays.filter((r): r is string => typeof r === 'string')
    : [];
  const expiresAt =
    typeof bundle.expires_at === 'number' ? bundle.expires_at : undefined;
  const icon = isImagePointer(bundle.icon) ? bundle.icon : undefined;
  const communityRoot =
    typeof bundle.community_root === 'string'
      ? bundle.community_root
      : undefined;
  const rootEpoch =
    typeof bundle.root_epoch === 'number' ? bundle.root_epoch : undefined;
  const communityId =
    typeof bundle.community_id === 'string' ? bundle.community_id : undefined;
  const controlPk =
    typeof bundle.control_pk === 'string' ? bundle.control_pk : undefined;

  // Extract channel identities (id + epoch) for GroupKey derivation.
  const channels: ArmadaChannel[] = channelsRaw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map(c => {
      const id = typeof c.id === 'string' ? c.id : '';
      const epoch = typeof c.epoch === 'number' ? c.epoch : 0;
      const chName = typeof c.name === 'string' ? c.name : undefined;
      return { id, epoch, ...(chName ? { name: chName } : {}) };
    })
    .filter(c => c.id);

  const preview: ArmadaInvitePreview = {
    name,
    channelCount: channelsRaw.length,
    relays: relays.slice(0, MAX_BOOTSTRAP_RELAYS),
    expired: typeof expiresAt === 'number' && Date.now() > expiresAt,
  };
  if (icon) preview.icon = icon;
  if (communityRoot) preview.communityRoot = communityRoot;
  if (typeof rootEpoch === 'number') preview.rootEpoch = rootEpoch;
  if (communityId) preview.communityId = communityId;
  if (controlPk) preview.controlPk = controlPk;
  if (channels.length > 0) preview.channels = channels;
  return preview;
}
