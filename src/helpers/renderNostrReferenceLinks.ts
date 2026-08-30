/**
 * renderNostrReferenceLinks — Inline single-line links for Nostr event refs.
 *
 * Field text (profile bios, future note-adjacent fields) can carry bare
 * `nevent1…` / `note1…` / `naddr1…` references. The quote-card pipeline is
 * too heavy for those — this helper rewrites every reference into a single
 * inline link that opens the referenced event in the SNV.
 *
 * Input contract: escaped HTML (run AFTER escapeHtml, like linkifyUrls).
 * The shared NOSTR_EVENT_REF_REGEX is URL-safe (`(?<!\/)` keeps it out of
 * href attributes written by linkifyUrls).
 *
 * Labels are synchronous from the profile cache; a cache miss primes the
 * profile fetch (fire-and-forget) so the next render shows the name — the
 * same pattern as the NIP-68 image tagline resolver.
 */

import { NOSTR_EVENT_REF_REGEX } from './extractQuotedReferences';
import { decodeNip19 } from '../services/NostrToolsAdapter';
import { UserProfileService } from '../services/UserProfileService';
import { escapeHtml } from './escapeHtml';

/** SNV href for any reference — bare bech32 (nostr: prefix stripped). */
function snvHref(fullMatch: string): string {
  return `/note/${fullMatch.replace(/^nostr:/, '')}`;
}

/** Label suffix for a reference author, from the profile cache. */
function authorSuffix(pubkey: string | undefined): string {
  if (!pubkey) return '';
  const name = UserProfileService.getInstance().getUsername(pubkey);
  if (name) return ` by ${escapeHtml(name)}`;
  // Prime the cache so a later render shows the name
  void UserProfileService.getInstance()
    .getUserProfile(pubkey)
    .catch(() => {
      /* background prime — silent */
    });
  return '';
}

/** Human label for an naddr target kind. */
function naddrLabel(kind: number): { icon: string; label: string } {
  if (kind === 30023) return { icon: 'icon-article', label: 'Article' };
  if (kind === 30311) return { icon: 'icon-note', label: 'Live stream' };
  if (kind === 32267) return { icon: 'icon-note', label: 'App' };
  return { icon: 'icon-note', label: 'Event' };
}

function refLink(fullMatch: string, icon: string, label: string): string {
  return `<a class="nostr-ref-link" href="${snvHref(fullMatch)}"><svg width="14" height="14" aria-hidden="true"><use href="#${icon}"/></svg><span>${label}</span></a>`;
}

/**
 * Rewrite every Nostr event reference in the (escaped) HTML into a single
 * inline link that opens the referenced event in the SNV. Leave everything
 * else untouched.
 */
export function renderNostrReferenceLinks(html: string): string {
  return html.replace(NOSTR_EVENT_REF_REGEX, (fullMatch: string) => {
    const bare = fullMatch.replace(/^nostr:/, '');
    try {
      const decoded = decodeNip19(bare);
      if (decoded.type === 'naddr') {
        const data = decoded.data as {
          kind: number;
          pubkey?: string;
        };
        const { icon, label } = naddrLabel(data.kind);
        return refLink(fullMatch, icon, `${label}${authorSuffix(data.pubkey)}`);
      }
      if (decoded.type === 'nevent') {
        const data = decoded.data as { author?: string };
        return refLink(
          fullMatch,
          'icon-note',
          `Note${authorSuffix(data.author)}`
        );
      }
      if (decoded.type === 'note') {
        return refLink(fullMatch, 'icon-note', 'Note');
      }
      // 'event' type or unknown — generic fallback
      return refLink(fullMatch, 'icon-note', 'Note');
    } catch {
      // Undecodable reference (e.g. malformed bech32) — still link it; the
      // SNV shows its own graceful "not found" state.
      return refLink(fullMatch, 'icon-note', 'Note');
    }
  });
}
