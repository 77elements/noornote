/**
 * NIP-98 HTTP Auth header builder (kind:27235).
 * Spec: https://github.com/nostr-protocol/nips/blob/master/98.md
 *
 * Signs a kind:27235 event with the current user via AuthService and base64-
 * encodes it for the `Authorization: Nostr <event>` header. The `payload` tag
 * is filled in with the SHA-256 of the body bytes (omit for GET).
 *
 * Used by MediaUploadService (NIP-96 uploads) and the NosPress custom-font
 * upload flow — keep both in sync via this single helper.
 */

import { AuthService } from '../services/AuthService';

const SIGN_TIMEOUT_MS = 15_000;

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buf: ArrayBuffer = bytes instanceof Uint8Array
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    : bytes;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function buildNip98AuthHeader(
  method: string,
  url: string,
  payloadSha256?: string
): Promise<string> {
  const auth = AuthService.getInstance();
  const user = auth.getCurrentUser();
  if (!user) throw new Error('Not authenticated');

  const tags: string[][] = [
    ['u', url],
    ['method', method.toUpperCase()]
  ];
  if (payloadSha256) tags.push(['payload', payloadSha256]);

  const signed = await Promise.race([
    auth.signEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
      pubkey: user.pubkey
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Signing timeout — check your signer extension')), SIGN_TIMEOUT_MS)
    )
  ]);

  return `Nostr ${btoa(JSON.stringify(signed))}`;
}
