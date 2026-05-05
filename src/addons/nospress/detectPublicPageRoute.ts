/**
 * Detect whether a top-level URL path is a public NosPress-page route.
 *
 * Valid forms (trailing slash optional):
 *   /alp@nostrplebs.com           → home page (slug='')
 *   /alp@nostrplebs.com/about     → sub page (slug='about')
 *   /npub1xyz...                  → home page via bech32 npub
 *   /npub1xyz.../about            → sub page via bech32 npub
 *
 * Reserved top-level routes (/welcome, /login, /about-app, /articles,
 * /notifications, /settings, /messages, /tribes, /setup, /createnewaccount,
 * /write-article, /write-video, /addons, /marketplace, /follow-pack,
 * /listing, /my-listings, /write-listing) are excluded automatically because
 * their first segment neither contains `@` nor matches `npub1...`.
 */

import { isValidSlug } from './blocks/pageIndex';

export type PublicPageRoute =
  | { type: 'nip05'; handle: string; slug: string }
  | { type: 'npub'; npub: string; slug: string };

const NIP05_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const NPUB_PATTERN = /^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/;

export function detectPublicPageRoute(pathname: string): PublicPageRoute | null {
  const trimmed = pathname.replace(/^\/|\/$/g, '');
  if (!trimmed) return null;

  const segments = trimmed.split('/').filter(s => s.length > 0);
  if (segments.length < 1 || segments.length > 2) return null;

  const handleSegment = segments[0]!;
  const slugSegment = segments[1] ?? '';

  // Sub-page slug must validate the same way the editor accepts it; reject
  // anything else so reserved routes (like `/login/foo`) can never be
  // hijacked into a public-page render.
  if (slugSegment && !isValidSlug(slugSegment)) return null;

  if (NIP05_PATTERN.test(handleSegment)) {
    return { type: 'nip05', handle: handleSegment, slug: slugSegment };
  }

  if (NPUB_PATTERN.test(handleSegment)) {
    return { type: 'npub', npub: handleSegment, slug: slugSegment };
  }

  return null;
}
