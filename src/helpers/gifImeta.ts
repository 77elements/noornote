/**
 * GIF helpers — pure logic for the gifs.nostr.build picker integration.
 *
 * Covers query validation (mirrors the API's server-side normalisation rules),
 * URL detection for media posted from the GIF picker, and NIP-92 `imeta` tag
 * construction so clients can lay the GIF out before loading it.
 *
 * Media host contract (gifs.nostr.build integration guide): media URLs
 * (`url`, previews, `mp4`) are always `https://gifs.nostr.build/…`; anything
 * else is treated as invalid. Item ids follow `^\w[\w.-]{0,199}$`.
 */

/** Host that serves all GIF media files (JSON API lives on the same host). */
export const GIF_MEDIA_HOST = 'gifs.nostr.build';

/** Metadata needed to build an `imeta` tag for one picked GIF. */
export interface GifMeta {
  /** MIME type from the API `format` field (`image/gif` or `image/webp`) */
  m: string;
  /** Pixel dimensions as `WxH` from the API `width`/`height` fields */
  dim: string;
  /** File size in bytes (API `bytes`); omitted from imeta when null */
  size?: number | null;
  /** Alt text (API `title`); omitted from imeta when empty */
  alt?: string;
}

/** Matches a gifs.nostr.build media URL inside note content. */
const GIF_URL_REGEX = new RegExp(
  `https:\\/\\/${GIF_MEDIA_HOST.replace('.', '\\.')}\\/[A-Za-z0-9._-]+`,
  'g'
);

/**
 * Check whether a URL points at the GIF media host (used to only accept
 * known-good media URLs from API responses before rendering/picking).
 */
export function isGifMediaUrl(url: string): boolean {
  try {
    return new URL(url).host === GIF_MEDIA_HOST;
  } catch {
    return false;
  }
}

/**
 * Validate a search query the way the server does BEFORE spending a request:
 * a query is only searchable if it contains at least one letter, digit or
 * emoji after trimming. Single Latin letters are noise and burn rate budget
 * (single emoji or CJK/Hangul characters are fine).
 */
export function isSearchableGifQuery(raw: string): boolean {
  const q = raw.trim();
  if (q.length === 0 || q.length > 500) return false;

  // Single Latin letter → skip (noise). Everything else with content passes.
  if (/^[a-zA-Z]$/.test(q)) return false;

  // Must contain at least one letter/digit (any script) or any emoji.
  // \p{L}\p{N} covers scripts like Cyrillic, CJK, Hangul, Arabic.
  return /[\p{L}\p{N}]/u.test(q) || /\p{Extended_Pictographic}/u.test(q);
}

/**
 * Extract unique gifs.nostr.build URLs from note content, in order of first
 * appearance. Only URLs whose id matches the API's id pattern are returned.
 */
export function extractGifUrlsFromContent(content: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of content.matchAll(GIF_URL_REGEX)) {
    const url = match[0];
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/**
 * Build NIP-92 `imeta` tags for every gifs.nostr.build URL in the content
 * that has cached metadata (i.e. was picked via the GIF picker). Deduped per
 * URL; `size`/`alt` lines are omitted when unknown, per the guide.
 *
 * @param content Note content to scan
 * @param lookup Cache lookup returning the metadata for one URL
 */
export function collectGifImetaTags(
  content: string,
  lookup: (url: string) => GifMeta | undefined
): string[][] {
  const tags: string[][] = [];
  for (const url of extractGifUrlsFromContent(content)) {
    const meta = lookup(url);
    if (!meta) continue;

    const parts: string[] = [`url ${url}`, `m ${meta.m}`, `dim ${meta.dim}`];
    if (typeof meta.size === 'number' && meta.size > 0) {
      parts.push(`size ${meta.size}`);
    }
    if (meta.alt && meta.alt.trim().length > 0) {
      parts.push(`alt ${meta.alt.trim()}`);
    }
    tags.push(['imeta', ...parts]);
  }
  return tags;
}

/** Map an API `format` field to the imeta `m` MIME value. */
export function gifFormatToMime(format: string): string {
  return format === 'webp' ? 'image/webp' : 'image/gif';
}
