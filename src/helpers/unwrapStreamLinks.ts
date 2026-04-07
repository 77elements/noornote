/**
 * Unwrap stream-provider URLs to raw nostr: references.
 *
 * Many Nostr live-stream providers (zap.stream, noomad.stream, highlighter.com, ...)
 * publish URLs like `https://zap.stream/naddr1...` where the path segment IS a
 * NIP-19 naddr. Amethyst and other clients unwrap these to `nostr:naddr1...` so
 * the quoted-reference pipeline can render the referenced event.
 *
 * Provider-agnostic: matches any `https?://<host>/<path>/<naddr1...>` pattern.
 * Also handles `nevent1...` / `note1...` in URLs for completeness.
 *
 * This runs in ContentProcessor BEFORE extractQuotedReferences, so the resulting
 * `nostr:naddr1...` is picked up as a normal quoted reference.
 */

// Matches any URL whose last path segment starts with naddr1 / nevent1 / note1.
// Negative lookahead on trailing chars to avoid capturing query strings / punctuation.
const STREAM_URL_REGEX =
  /https?:\/\/[^\s/]+\/(?:[^\s/]+\/)*((?:naddr1|nevent1|note1)[02-9ac-hj-np-z]+)(?=[^02-9ac-hj-np-z]|$)/gi;

export function unwrapStreamLinks(text: string): string {
  return text.replace(STREAM_URL_REGEX, (_match, ref) => `nostr:${ref}`);
}
