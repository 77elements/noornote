/**
 * NIP-73 web-page reference extraction for NIP-22 comments (kind:1111).
 *
 * A comment "on a web page" carries the page URL as a NIP-73 external content id
 * with the `web` kind marker:
 *   - top-level comment: ["I", url], ["K", "web"], ["i", url], ["k", "web"]
 *   - reply to such a comment: ["I", url], ["K", "web"], ["e", parentId], ["k", "1111"]
 *
 * So the page URL always lives in the ROOT scope (uppercase `I`); lowercase `i`
 * only holds the URL for a top-level comment (where parent == root). We therefore
 * prefer `I` and fall back to `i`. The `web` marker may sit in `K` (root) or `k`
 * (parent), so we accept either casing for the presence check.
 */

export interface WebRef {
  /** The external web page this comment is anchored to. */
  url: string;
}

/** Cheap presence check — true if any `k`/`K` tag marks this as web-scoped. */
export function hasWebScopeTag(tags: string[][]): boolean {
  return tags.some(t => (t[0] === 'k' || t[0] === 'K') && t[1] === 'web');
}

const HTTP_URL = /^https?:\/\//i;

/**
 * Extract the web page reference from a comment's tags, or null if the note is
 * not a web-scoped comment. Prefers the root scope (`I`) over the parent (`i`).
 */
export function extractWebRef(tags: string[][]): WebRef | null {
  if (!hasWebScopeTag(tags)) return null;

  const root = tags.find(t => t[0] === 'I' && HTTP_URL.test(t[1] || ''));
  const parent = tags.find(t => t[0] === 'i' && HTTP_URL.test(t[1] || ''));
  const url = root?.[1] || parent?.[1];
  if (!url) return null;

  return { url };
}
