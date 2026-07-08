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
// The capture group is JUST the NIP-19 id; the optional trailing `[#?]\S*` swallows
// the URL's own query string / fragment (e.g. an invite key like `...naddr1…#BAAC…`)
// so it isn't left dangling as cryptic text once the URL is replaced by `nostr:<id>`.
// `\S*` stops at whitespace, so text after the URL is untouched.
const STREAM_URL_REGEX =
  /https?:\/\/[^\s/]+\/(?:[^\s/]+\/)*((?:naddr1|nevent1|note1)[02-9ac-hj-np-z]+)(?:[#?]\S*)?/gi;

export function unwrapStreamLinks(text: string): string {
  return text.replace(STREAM_URL_REGEX, (_match, ref) => `nostr:${ref}`);
}
