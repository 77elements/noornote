/**
 * Multi-page index for NosPress sites.
 *
 * Backwards-compat: when the index has only the home entry (slug=''), the
 * underlying NIP-78 event for that page stays under the legacy d-tag
 * `noornote/list`. Additional pages use `noornote/page/<slug>`.
 *
 * Slug rules:
 *  - lowercase ASCII, [a-z0-9-]
 *  - max 30 chars
 *  - immutable after creation (renaming would break URLs)
 *  - empty string = home (default landing page)
 */

export interface PageIndexEntry {
  slug: string;
  title: string;
}

export interface NospressPageIndex {
  version: 1;
  pages: PageIndexEntry[];
}

export const HOME_SLUG = '';

/** Reserved storage slugs for the site-wide global header / footer.
 *  Never appear in the page-index — they're addressed only via the
 *  editor's `editingTarget` state. Picked with a `__` prefix so they
 *  can never collide with a user-chosen slug (validation rejects `_`). */
export const GLOBAL_HEADER_SLUG = '__header';
export const GLOBAL_FOOTER_SLUG = '__footer';

export const DEFAULT_PAGE_INDEX: NospressPageIndex = {
  version: 1,
  pages: [{ slug: HOME_SLUG, title: 'Home' }],
};

export function isPageIndex(data: unknown): data is NospressPageIndex {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as { version?: unknown; pages?: unknown };
  if (obj.version !== 1 || !Array.isArray(obj.pages)) return false;
  return obj.pages.every(p => p && typeof (p as PageIndexEntry).slug === 'string' && typeof (p as PageIndexEntry).title === 'string');
}

const SLUG_PATTERN = /^[a-z0-9-]{1,30}$/;

export function normalizeSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

export function isValidSlug(slug: string): boolean {
  if (slug === HOME_SLUG) return true;
  return SLUG_PATTERN.test(slug);
}
