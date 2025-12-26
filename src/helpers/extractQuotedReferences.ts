/**
 * Extract quoted nostr references from text content
 * Single purpose: text → QuotedReference[]
 * Handles: nostr:event, nostr:note, nostr:nevent, nostr:addr
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
}

export function extractQuotedReferences(text: string): QuotedReference[] {
  const quotes: QuotedReference[] = [];

  // Regex to catch all nostr references (event, note, nevent, naddr)
  // Matches both "nostr:nevent1..." AND standalone "nevent1..." (optional nostr: prefix)
  // Negative lookbehind (?<!\/) prevents matching inside URL paths (e.g., https://example.com/naddr1...)
  const nostrRegex = /(?<!\/)(?:nostr:)?(event1[023456789acdefghjklmnpqrstuvwxyz]{58}|note1[023456789acdefghjklmnpqrstuvwxyz]{58}|nevent1[023456789acdefghjklmnpqrstuvwxyz]+|naddr1[023456789acdefghjklmnpqrstuvwxyz]+)(?=[^023456789acdefghjklmnpqrstuvwxyz]|$)/gi;

  const matches = Array.from(text.matchAll(nostrRegex));

  matches.forEach(match => {
    const fullMatch = match[0];

    // Determine type from the match
    let type = 'unknown';
    if (fullMatch.includes('event1')) type = 'event';
    else if (fullMatch.includes('note1')) type = 'note';
    else if (fullMatch.includes('nevent1')) type = 'nevent';
    else if (fullMatch.includes('naddr')) type = 'addr';

    quotes.push({
      type,
      id: fullMatch, // Keep full reference for fetching
      fullMatch: fullMatch
    });
  });

  return quotes;
}