/**
 * Format quoted references as placeholder elements
 * Single purpose: HTML + QuotedReference[] → HTML with formatted quote placeholders
 *
 * For Armada invite refs that carry a `fragment`, the marker carries the
 * secret in `data-armada-fragment` so the renderer can decrypt the bundle.
 *
 * @param html - HTML content
 * @param quotedReferences - Array of QuotedReference objects
 * @returns HTML with references replaced by placeholder spans
 *
 * @example
 * formatQuotedReferences(html, [{ type: 'note', id: 'nostr:note1...', fullMatch: '...' }])
 * // => HTML with <span class="quote-marker" data-quote-ref="..."></span>
 */

export interface QuotedReference {
  type: 'event' | 'note' | 'addr';
  id: string;
  fullMatch: string;
  fragment?: string;
}

export function formatQuotedReferences(html: string, quotedReferences: QuotedReference[]): string {
  // Dedupe by fullMatch and use replaceAll, because:
  //   1. replace(string, ...) replaces only the first occurrence → duplicate
  //      refs (same nevent quoted twice) would leave later copies raw.
  //   2. The replacement contains the fullMatch itself in data-quote-ref.
  //      With repeated replace() calls on the same fullMatch, iteration N+1
  //      matches INSIDE iteration N's attribute, producing malformed nested
  //      HTML and breaking every quote from that point onward.
  //   split+join does one pass without re-scanning replacements, so both
  //   problems disappear. (Equivalent to replaceAll, but our TS lib target
  //   predates String.prototype.replaceAll.)
  const seen = new Set<string>();
  quotedReferences.forEach(ref => {
    if (seen.has(ref.fullMatch)) return;
    seen.add(ref.fullMatch);
    const fragmentAttr = ref.fragment
      ? ` data-armada-fragment="${ref.fragment}"`
      : '';
    const marker = `<span class="quote-marker" data-quote-ref="${ref.fullMatch}"${fragmentAttr}></span>`;
    html = html.split(ref.fullMatch).join(marker);
  });
  return html;
}
