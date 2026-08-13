/**
 * Concord V2 GroupKey derivation — CORD-02 Appendix A (frozen).
 *
 * Ported from Armada's `src/concord-v2/lib/derive.ts`. Each channel in a
 * Concord community has a deterministic secp256k1 keypair derived from the
 * community root + channel id + epoch. The x-only pubkey is the "stream
 * address" (the `authors` filter for gift wraps), and the self-ECDH
 * conversation key encrypts the wraps.
 *
 * Wire format: `HKDF-SHA256(ikm=community_root, salt=∅, info, L=32)` where
 * `info = utf8("concord/channel") || 0x00 || channelId[32] || epoch_be[8]`.
 * The 32-byte output is reduced to a valid secp256k1 secret key via the
 * scalar_normalize retry counter (A.3).
 */

import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { nip44ConversationKey } from '../../../services/NostrToolsAdapter';

const LABEL_CHANNEL = 'concord/channel';
const LABEL_CONTROL = 'concord/control';

/**
 * `utf8(label) || 0x00 || id[32] || epoch_be[8]` — CORD-02 A.1 info layout.
 */
function buildInfo(label: string, id32: Uint8Array, epoch: bigint): Uint8Array {
  const labelBytes = new TextEncoder().encode(label);
  const out = new Uint8Array(labelBytes.length + 1 + 32 + 8);
  let o = 0;
  out.set(labelBytes, o); o += labelBytes.length;
  out[o] = 0x00; o += 1;
  out.set(id32, o); o += 32;
  new DataView(out.buffer).setBigUint64(o, epoch, false);
  return out;
}

function hkdf32(ikm: Uint8Array, info: Uint8Array): Uint8Array {
  return hkdf(sha256, ikm, new Uint8Array(0), info, 32);
}

/**
 * Reduce an HKDF seed to a valid secp256k1 secret key. If the seed is not a
 * valid scalar, append an incrementing counter byte to the info and retry
 * (CORD-02 A.3 scalar_normalize).
 */
function hkdfToSecretKey(ikm: Uint8Array, baseInfo: Uint8Array): Uint8Array {
  {
    const seed = hkdf32(ikm, baseInfo);
    if (secp256k1.utils.isValidSecretKey(seed)) return seed;
  }
  for (let counter = 0; counter <= 0xff; counter++) {
    const info = new Uint8Array(baseInfo.length + 1);
    info.set(baseInfo, 0);
    info[baseInfo.length] = counter;
    const seed = hkdf32(ikm, info);
    if (secp256k1.utils.isValidSecretKey(seed)) return seed;
  }
  throw new Error('scalar rejection 257 times running is impossible');
}

export interface GroupKey {
  /** secp256k1 secret key (signs the plane's wraps). */
  sk: Uint8Array;
  /** x-only pubkey hex — the Stream address (`authors` filter). */
  pk: string;
  /** NIP-44 conversation key (self-ECDH of sk with pk). */
  convKey: Uint8Array;
}

/**
 * Derive a channel's GroupKey from the community root, channel id, and epoch.
 *
 * @param communityRootHex - 64-char hex community root (from the invite bundle)
 * @param channelIdHex - 64-char hex channel id (from the invite bundle)
 * @param epoch - the channel's current epoch number
 */
export function channelGroupKey(communityRootHex: string, channelIdHex: string, epoch: number): GroupKey {
  return groupKeyDerive(communityRootHex, channelIdHex, epoch, LABEL_CHANNEL);
}

/**
 * Derive the Control Plane's GroupKey — used for community-level activity
 * detection (new channels, roster updates, rekey events). When a community
 * has no explicit channels in the bundle preview, polling the control plane
 * is the only way to detect activity.
 */
export function controlGroupKey(communityRootHex: string, communityIdHex: string, epoch: number): GroupKey {
  return groupKeyDerive(communityRootHex, communityIdHex, epoch, LABEL_CONTROL);
}

function groupKeyDerive(rootHex: string, idHex: string, epoch: number, label: string): GroupKey {
  const secret = hexToBytes(rootHex);
  const id = hexToBytes(idHex);
  const info = buildInfo(label, id, BigInt(epoch));
  const sk = hkdfToSecretKey(secret, info);
  const pk = bytesToHex(schnorr.getPublicKey(sk));
  const convKey = nip44ConversationKey(bytesToHex(sk), pk);
  return { sk, pk, convKey };
}
