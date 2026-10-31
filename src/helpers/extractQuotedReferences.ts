/**
 * Extract quoted nostr references from text content
 * Single purpose: text → QuotedReference[]
 * Handles: nostr:event, nostr:note, nostr:nevent, nostr:addr
 *
 * For naddr references that carry a Concord invite unlock secret in a
 * `#fragment` suffix (e.g. `nostr:naddr1…#BAHcYKk…`, produced by
 * `unwrapArmadaInviteLinks`), the fragment is captured into the
 * `fragment` field instead of being lost — the renderer needs it to
 * NIP-44-decrypt the bundle's public preview.
 *
 * @param text - Raw text content to extract quoted references from
 * @returns Array of QuotedReference objects
 *
 * @example
 * extractQuotedReferences("See nostr:note1abc...")
 * // => [{ type: 'note', id: 'nostr:note1abc...', fullMatch: 'nostr:note1abc...' }]
 */

import { decodeNip19 } from '../services/NostrToolsAdapter';

export interface QuotedReference {
  type: string;
  id: string;
  fullMatch: string;
  /**
   * Armada / Concord invite unlock fragment (without the leading `#`).
   * Present only for naddr refs whose `#fragment` survived the URL unwrap
   * (i.e. an armada.buzz invite link or a bare `naddr1…#frag`). Other refs
   * have no fragment — undefined.
   */
  fragment?: string;
  /**
   * Hex pubkeys of the quoted event's author, derived from the PARENT
   * event's tags (NIP-18 `q` tag 4th element; fallback: the parent's `p`
   * tags). Only meaningful for refs that carry no author of their own
   * (bare `note1…` / hex) — a `nevent1…` embeds its author and the
   * orchestrator prefers that anyway. Used as extra stage-3 outbound
   * candidates so cross-relay quotes resolve.
   */
  authorHints?: string[];
}

const HEX64 = /^[a-f0-9]{64}$/;

/**
 * Enrich bare quoted references with the quoted event's author pubkey taken
 * from the parent event's tags, as stage-3 outbound candidates.
 *
 * A bare `nostr:note1…` quote carries neither relay hints nor the quoted
 * author. The pipeline's outbound fallback (QuoteOrchestrator stage 3) can
 * then only guess via the quoter's own relays — but the quoted author is
 * sitting in the parent's tags: NIP-18 quotes pair the `q` tag (4th element
 * = author) or the `q`-tagged id with a `p` tag of the quoted author. When
 * the pairing is ambiguous (several `q` tags), fall back to the parent's
 * `p`-tag pubkeys as a conservative union — a wrong candidate only costs one
 * cheap NIP-65 lookup, a missing one loses the quote.
 */
export function enrichQuoteAuthorHints(
  refs: QuotedReference[],
  tags: string[][]
): void {
  if (refs.length === 0 || tags.length === 0) return;

  const qTags = tags.filter(t => t[0] === 'q');
  const pTagPubkeys = Array.from(
    new Set(
      tags
        .filter(t => t[0] === 'p' && t[1] && HEX64.test(t[1]))
        .map(t => t[1] as string)
    )
  ).slice(0, 4);
  if (qTags.length === 0 && pTagPubkeys.length === 0) return;

  const parentHintsById = new Map<string, string[]>();
  for (const ref of refs) {
    // nevent embeds its author — the orchestrator already prefers it. Skip
    // only author-carrying nevents; author-less nevents benefit like bare refs.
    if (ref.type === 'addr') continue;

    const parsed = parseRefEventId(ref.fullMatch.replace(/^nostr:/, ''));
    if (!parsed || parsed.hasAuthor) continue;

    const eventId = parsed.id;
    let hints = parentHintsById.get(eventId);
    if (!hints) {
      const qTag = qTags.find(t => t[1] === eventId && HEX64.test(t[3] ?? ''));
      hints =
        qTag && qTag[3] && HEX64.test(qTag[3])
          ? [qTag[3] as string]
          : pTagPubkeys;
      parentHintsById.set(eventId, hints);
    }
    if (hints.length > 0) ref.authorHints = hints;
  }
}

/** Decoded reference: hex event id + whether the ref embeds its author. */
function parseRefEventId(
  cleanRef: string
): { id: string; hasAuthor: boolean } | null {
  if (HEX64.test(cleanRef)) return { id: cleanRef, hasAuthor: false };
  try {
    const decoded = decodeNip19(cleanRef);
    if (decoded.type === 'note') {
      return { id: decoded.data as string, hasAuthor: false };
    }
    if (decoded.type === 'nevent') {
      const data = decoded.data as { id?: string; author?: string };
      if (!data.id) return null;
      return { id: data.id, hasAuthor: !!data.author };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Matches Nostr event references — both "nostr:nevent1…" AND bare "nevent1…"
 * (negative lookbehinds `(?<!\/)` + `(?<![?&=])` keep the pattern out of
 * URLs — both path segments and query params like `?naddr=naddr1…`).
 * Shared single source of truth: extractQuotedReferences (quote boxes) and
 * renderNostrReferenceLinks (inline single-line links) both use this.
 */
export const NOSTR_EVENT_REF_REGEX =
  /(?<!\/)(?<![?&=])(?:nostr:)?(event1[023456789acdefghjklmnpqrstuvwxyz]{58}|note1[023456789acdefghjklmnpqrstuvwxyz]{58}|nevent1[023456789acdefghjklmnpqrstuvwxyz]+|naddr1[023456789acdefghjklmnpqrstuvwxyz]+)(#([A-Za-z0-9_-]+))?(?=[^023456789acdefghjklmnpqrstuvwxyz#]|$)/gi;

export function extractQuotedReferences(text: string): QuotedReference[] {
  const quotes: QuotedReference[] = [];

  // Regex to catch all nostr references (event, note, nevent, naddr)
  // Matches both "nostr:nevent1..." AND standalone "nevent1..." (optional nostr: prefix)
  // Negative lookbehinds (?<!\/) + (?<![?&=]) prevent matching inside URLs —
  // both paths (https://example.com/naddr1...) and query params
  // (https://example.com/?naddr=naddr1...).
  //
  // Optional `#fragment` group: armada invite secrets are base64url
  // (`[A-Za-z0-9_\-]+`). Captured separately so it survives into the marker
  // and reaches the renderer; the lookahead after it requires the next char
  // to NOT be a bech32 char (so we don't swallow trailing bech32 body) AND
  // not another `#` (defensive — no double-fragment).
  // The pattern itself lives in NOSTR_EVENT_REF_REGEX above (shared).
  const matches = Array.from(text.matchAll(NOSTR_EVENT_REF_REGEX));

  matches.forEach(match => {
    const fullMatch = match[0];
    const fragment = match[3] as string | undefined;

    // Determine type from the match
    let type = 'unknown';
    if (fullMatch.includes('event1')) type = 'event';
    else if (fullMatch.includes('note1')) type = 'note';
    else if (fullMatch.includes('nevent1')) type = 'nevent';
    else if (fullMatch.includes('naddr')) type = 'addr';

    quotes.push({
      type,
      id: fullMatch, // Keep full reference for fetching
      fullMatch,
      ...(fragment ? { fragment } : {}),
    });
  });

  // Bare hex event IDs with explicit nostr: prefix
  // (from NoteMenu → "Copy event ID", which yields raw hex).
  // Requires the nostr: prefix to avoid matching unrelated 64-hex strings.
  const hexRegex = /nostr:([a-f0-9]{64})(?=[^a-f0-9]|$)/gi;
  Array.from(text.matchAll(hexRegex)).forEach(match => {
    const fullMatch = match[0];
    quotes.push({
      type: 'event',
      id: fullMatch,
      fullMatch,
    });
  });

  return quotes;
}
