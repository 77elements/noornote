/**
 * Detect whether a top-level URL path is a public NosPress-page route.
 *
 * Two valid forms:
 *   /alp@nostrplebs.com  → NIP-05 handle
 *   /npub1xyz...         → bech32 npub
 *
 * Top-level only (no nested path), trailing slash is optional. Reserved
 * top-level routes (/welcome, /login, /about, /articles, /notifications,
 * /settings, /messages, /tribes, /setup, /createnewaccount, /write-article,
 * /write-video, /addons, /marketplace, /follow-pack, /listing, /my-listings,
 * /write-listing) are excluded automatically because they neither contain
 * `@` nor start with `npub1`.
 */

export type PublicPageRoute =
  | { type: 'nip05'; handle: string }
  | { type: 'npub'; npub: string };

export function detectPublicPageRoute(pathname: string): PublicPageRoute | null {
  const trimmed = pathname.replace(/^\/|\/$/g, '');
  if (!trimmed || trimmed.includes('/')) return null;

  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
    return { type: 'nip05', handle: trimmed };
  }

  if (/^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(trimmed)) {
    return { type: 'npub', npub: trimmed };
  }

  return null;
}
