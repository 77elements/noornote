/**
 * Preserve armada.buzz invite URLs through the content pipeline.
 *
 * Problem: `unwrapStreamLinks` runs first on any URL whose last path segment
 * is a NIP-19 id, and rewrites e.g.
 *   `https://armada.buzz/invite/naddr1…#BAHcYKk…`
 * to
 *   `nostr:naddr1…`
 * — **dropping the `#fragment`**, which is the invite's unlock secret. The
 * downstream naddr embed then sees kind 33301 with no fragment, can't
 * decrypt the public preview, and renders a bare "unsupported kind" card.
 *
 * This helper runs BEFORE unwrapStreamLinks. It detects armada.buzz invite
 * URLs (with or without fragment) and rewrites them to `nostr:naddr1…#fragment`,
 * preserving the secret. The downstream regex in extractQuotedReferences is
 * extended to capture that `#fragment` into a `fragment` field on the
 * QuotedReference, and QuotedNoteRenderer routes kind 33301 to the
 * ArmadaInviteRenderer with both naddr and fragment in hand.
 *
 * Also handles bare `naddr1…#fragment` (no URL host) for invites pasted
 * without the armada.buzz wrapper — same preservation rule.
 *
 * (Bare `naddr1…` without a fragment is left untouched; the standard
 * `(?<!\/)` lookbehind in extractQuotedReferences picks it up as a normal
 * naddr quote and renders the static "Encrypted community" card via the
 * kind 33301 branch in QuotedNoteRenderer.)
 */

import { parseArmadaInvite } from './armada/parseArmadaInvite';

/**
 * Matches an armada.buzz invite URL with optional `#fragment`.
 * Examples it matches:
 *   https://armada.buzz/invite/naddr1…#BAHcYKk…
 *   https://armada.buzz/invite/naddr1…
 *   armada.buzz/invite/naddr1…#BAHcYk…
 * It does NOT match other hosts that happen to embed naddr in the path —
 * those keep going through unwrapStreamLinks as before.
 */
const ARMADA_URL_REGEX =
  /https?:\/\/(?:www\.)?armada\.buzz\/invite\/(naddr1[02-9ac-hj-np-z]+)(#[A-Za-z0-9_\-]+)?/gi;

/**
 * Matches a bare invite-bundle naddr with a `#fragment`. We only rewrite
 * when the fragment is present — a bare naddr without fragment is left for
 * the generic naddr-embed pipeline (and rendered as the static card).
 *
 * The leading boundary `(?<!\/)` mirrors extractQuotedReferences so we
 * don't double-match a naddr that's already inside a URL we just rewrote.
 */
const BARE_NADDR_WITH_FRAGMENT_REGEX =
  /(?<!\/)(naddr1[02-9ac-hj-np-z]+)(#[A-Za-z0-9_-]+)/gi;

export function unwrapArmadaInviteLinks(text: string): string {
  return text
    .replace(ARMADA_URL_REGEX, (full, naddr: string, fragment?: string) => {
      // Only rewrite if this is actually a kind 33301 invite bundle (paranoia —
      // armada.buzz/invite/<other-naddr> shouldn't exist, but cheap to check).
      if (!parseArmadaInvite(full)) return full;
      return `nostr:${naddr}${fragment ?? ''}`;
    })
    .replace(
      BARE_NADDR_WITH_FRAGMENT_REGEX,
      (full, naddr: string, fragment: string) => {
        // Not an invite-bundle naddr — leave for the generic pipeline.
        if (!parseArmadaInvite(`${naddr}${fragment}`)) return full;
        return `nostr:${naddr}${fragment}`;
      }
    );
}
