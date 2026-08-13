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
}

export function extractQuotedReferences(text: string): QuotedReference[] {
  const quotes: QuotedReference[] = [];

  // Regex to catch all nostr references (event, note, nevent, naddr)
  // Matches both "nostr:nevent1..." AND standalone "nevent1..." (optional nostr: prefix)
  // Negative lookbehind (?<!\/) prevents matching inside URL paths (e.g. https://example.com/naddr1...)
  //
  // Optional `#fragment` group: armada invite secrets are base64url
  // (`[A-Za-z0-9_\-]+`). Captured separately so it survives into the marker
  // and reaches the renderer; the lookahead after it requires the next char
  // to NOT be a bech32 char (so we don't swallow trailing bech32 body) AND
  // not another `#` (defensive — no double-fragment).
  const nostrRegex =
    /(?<!\/)(?:nostr:)?(event1[023456789acdefghjklmnpqrstuvwxyz]{58}|note1[023456789acdefghjklmnpqrstuvwxyz]{58}|nevent1[023456789acdefghjklmnpqrstuvwxyz]+|naddr1[023456789acdefghjklmnpqrstuvwxyz]+)(#([A-Za-z0-9_\-]+))?(?=[^023456789acdefghjklmnpqrstuvwxyz#]|$)/gi;

  const matches = Array.from(text.matchAll(nostrRegex));

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
      fullMatch: fullMatch,
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
      fullMatch
    });
  });

  return quotes;
}
