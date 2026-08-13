/**
 * Decrypt an Armada encrypted community image (Concord CORD-02 §6).
 *
 * Ported from Ditto's lib/armadaImage.ts (decryptArmadaImage).
 *
 * A community icon never touches a media server in plaintext: it's
 * AES-256-GCM encrypted under a fresh random key and uploaded as an
 * ordinary blob; the bundle carries only the pointer
 * `{ url, key, nonce, hash }`. We fetch the ciphertext, decrypt it, and
 * verify the plaintext SHA-256 against `hash` so a swapped blob fails
 * closed. Returns undefined on any failure (bad URL, fetch error, decrypt
 * error, integrity mismatch) so callers fall back to the crest.
 */

import { gcm } from '@noble/ciphers/aes';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { ArmadaImagePointer } from './types';

/** Best-effort mime sniff from magic bytes (display only). */
function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  if (bytes.length >= 5 && bytes[0] === 0x3c) return 'image/svg+xml'; // '<' — svg-ish
  return 'application/octet-stream';
}

/**
 * Fetch + decrypt an encrypted community image pointer to an object URL.
 *
 * Verifies the plaintext SHA-256 against `pointer.hash`; the caller MUST
 * revoke the returned URL once the element is gone (image onload / element
 * teardown). Returns undefined on any failure (bad URL, fetch error, decrypt
 * error, integrity mismatch).
 *
 * Privacy note (AGENTS.md §5): the URL comes from a decrypted community
 * bundle — i.e. from data the user already chose to open by clicking the
 * armada.buzz invite link. We fetch the ciphertext only (no npub, no auth,
 * no identifying headers). The media host learns that someone fetched this
 * blob URL, which is the same surface as any <img src="..."> in a feed.
 */
export async function decryptArmadaImage(
  pointer: ArmadaImagePointer,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // The blob URL comes from untrusted event data — only fetch well-formed HTTPS.
  // (Plain http would leak the path; non-http(s) schemes are nonsensical here.)
  let url: URL;
  try {
    url = new URL(pointer.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;

  try {
    // Build RequestInit conditionally — `signal: undefined` is not assignable
    // under exactOptionalPropertyTypes (RequestInit.signal is `AbortSignal | null`).
    const init: RequestInit = { redirect: 'follow' };
    if (signal) init.signal = signal;
    const res = await fetch(url.toString(), init);
    if (!res.ok) return undefined;

    const ciphertext = new Uint8Array(await res.arrayBuffer());
    let plaintext: Uint8Array;
    try {
      plaintext = gcm(hexToBytes(pointer.key), hexToBytes(pointer.nonce)).decrypt(ciphertext);
    } catch {
      return undefined;
    }

    if (bytesToHex(sha256(plaintext)) !== pointer.hash.toLowerCase()) {
      return undefined; // integrity check failed — a swapped blob
    }
    const mime = sniffImageMime(plaintext);
    // Cast plaintext.buffer to ArrayBuffer — TS 5.7 widened Uint8Array's
    // underlying buffer to ArrayBufferLike (which includes SharedArrayBuffer),
    // but BlobPart requires a real ArrayBuffer. Our plaintext is allocated
    // locally and never shared, so this cast is sound.
    return URL.createObjectURL(new Blob([plaintext.buffer as ArrayBuffer], { type: mime }));
  } catch {
    return undefined;
  }
}
