/**
 * Decode an Armada invite fragment into its unlock token + bootstrap relays.
 *
 * Ported from Ditto's lib/armadaInvite.ts (decodeInviteFragment), itself a
 * port of Concord's CORD-05 §3 fragment codec.
 *
 * Fragment layout (base64url-decoded bytes):
 *   - 1 byte version  (only `4` is the current generation)
 *   - 1 byte flags    (bit 0 = stock relay dictionary in use)
 *   - if stock set: nothing more on the relay side
 *   - else: 1 byte count, then `count` relay encodings (dict id, or len+bytes)
 *   - 16 bytes unlock token (random — input to the bundle HKDF)
 *
 * On a wrong version, a truncated buffer, an oversized relay count, or
 * trailing garbage, returns `undefined`. Callers fall back to the static
 * "Encrypted community" card with an "Open in Armada" button.
 */

const TOKEN_BYTES = 16;
const MAX_BOOTSTRAP_RELAYS = 3;
const FRAGMENT_VERSION = 4;
const FLAG_STOCK_SET = 0x01;

/** The stock relay dictionary (generation 4) — same list Vector, Soapbox and Ditto ship. */
const RELAY_DICTIONARY: Record<number, string> = {
  1: 'wss://jskitty.com/nostr',
  2: 'wss://asia.vectorapp.io/nostr',
  3: 'wss://relay.ditto.pub',
  4: 'wss://relay.dreamith.to',
};

/** All stock relays in dictionary order — used when the fragment carries FLAG_STOCK_SET. */
export const STOCK_RELAYS: string[] = [1, 2, 3, 4]
  .map((i) => RELAY_DICTIONARY[i])
  .filter((url): url is string => typeof url === 'string');

export interface DecodedFragment {
  /** 16-byte unlock token — input to inviteBundleKey(). */
  token: Uint8Array;
  /** Bootstrap relays that always host the bundle (CORD-05 §3). */
  relays: string[];
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode an invite fragment into its unlock token + bootstrap relays, or undefined. */
export function decodeInviteFragment(fragment: string): DecodedFragment | undefined {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(fragment.trim());
  } catch {
    return undefined;
  }

  let o = 0;
  const need = (n: number) => o + n <= bytes.length;
  if (!need(2)) return undefined;
  const version = bytes[o++];
  // Only the current generation is understood; older/newer decode against the
  // wrong dictionary, so bail (the card still offers "open in Armada").
  if (version !== FRAGMENT_VERSION) return undefined;
  const flags = bytes[o++];

  const relays: string[] = [];
  // Stock relay set: fragment carries only the flag bit, expand to the full dictionary.
  if ((flags ?? 0) & FLAG_STOCK_SET) {
    relays.push(...STOCK_RELAYS);
  } else {
    if (!need(1)) return undefined;
    const count = bytes[o++];
    if (count === undefined || count > MAX_BOOTSTRAP_RELAYS) return undefined;
    const decoder = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (!need(1)) return undefined;
      const lead = bytes[o++];
      if (lead === undefined) return undefined;
      if (lead >= 1 && lead <= 254) {
        const url = RELAY_DICTIONARY[lead];
        if (url) relays.push(url); // unknown id is skipped, not fatal
      } else {
        if (!need(1)) return undefined;
        const len = bytes[o++];
        if (len === undefined || !need(len)) return undefined;
        const text = decoder.decode(bytes.slice(o, o + len));
        o += len;
        relays.push(lead === 255 ? text : `wss://${text}`);
      }
    }
  }

  if (!need(TOKEN_BYTES)) return undefined;
  const token = bytes.slice(o, o + TOKEN_BYTES);
  o += TOKEN_BYTES;
  if (o !== bytes.length) return undefined;
  return { token, relays };
}
