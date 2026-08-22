/**
 * Parse an Armada / Concord community invite link.
 *
 * Ported from Ditto's lib/armadaInvite.ts (parseArmadaInvite), adapted to
 * NoorNote's NostrToolsAdapter (no direct nostr-tools import).
 *
 * An invite is a URL in two parts (Concord CORD-05):
 *  - a public locator in the path: a bare NIP-19 `naddr` naming the
 *    addressable invite bundle `(kind 33301, link_signer, d="")`
 *  - a secret in the `#fragment` (an unlock token + bootstrap relays,
 *    base64url). The bundle's `content` is NIP-44 encrypted under a key
 *    derived from this token, and the token lives ONLY in the fragment.
 *
 * NoorNote is not an encrypted-community client, so it can't join these.
 * But it can recognize the link and offer to open it in Armada — and, when
 * the fragment is present, decrypt the bundle's public preview to render
 * a real invitation card (name, icon, channel count).
 */

import { decodeNip19 } from '../../services/NostrToolsAdapter';
import {
  ARMADA_INVITE_BASE,
  INVITE_BUNDLE_KIND,
  type ArmadaInvite,
} from './types';

/** The `…/invite/<naddr>` path prefix used by Armada links. */
const INVITE_PATH_PREFIX = '/invite/';

/** Decode a bare naddr into its link-signer pubkey, or undefined if it isn't an invite bundle. */
function naddrToSigner(naddr: string): string | undefined {
  try {
    const decoded = decodeNip19(naddr);
    if (decoded.type !== 'naddr') return undefined;
    if (
      decoded.data.kind !== INVITE_BUNDLE_KIND ||
      decoded.data.identifier !== ''
    )
      return undefined;
    return decoded.data.pubkey;
  } catch {
    return undefined;
  }
}

/**
 * Parse a community invite from a full URL (`…/invite/<naddr>#<fragment>`) or
 * a bare `naddr#fragment`. Returns `undefined` for anything that isn't a
 * recognizably invite-bundle link, so callers can fall through to the
 * generic naddr embed / unsupported-kind fallback.
 */
export function parseArmadaInvite(input: string): ArmadaInvite | undefined {
  const trimmed = input.trim();

  let naddr: string | undefined;
  let fragment = '';

  if (/^naddr1[023456789acdefghjklmnpqrstuvwxyz]+/i.test(trimmed)) {
    const [head, ...rest] = trimmed.split('#');
    naddr = head;
    fragment = rest.join('#');
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (!url.pathname.startsWith(INVITE_PATH_PREFIX)) return undefined;
    naddr = decodeURIComponent(
      url.pathname.slice(INVITE_PATH_PREFIX.length)
    ).replace(/\/$/, '');
    fragment = url.hash.replace(/^#/, '');
  }

  if (!naddr) return undefined;
  const linkSigner = naddrToSigner(naddr);
  if (!linkSigner) return undefined;

  const openUrl = `${ARMADA_INVITE_BASE}${naddr}${fragment ? `#${fragment}` : ''}`;

  return {
    naddr,
    linkSigner,
    fragment,
    openUrl,
    missingSecret: fragment.length === 0,
  };
}

/** Whether `input` is a community invite link (with or without its `#fragment`). */
export function isArmadaInvite(input: string): boolean {
  return parseArmadaInvite(input) !== undefined;
}
