/**
 * EPUB detection helpers
 * Single purpose: detect EPUB book links in Nostr notes.
 *
 * Three detection sources (see docs/todos/epub-reader.md):
 * 1. NIP-92 imeta tag with `m application/epub+zip` (supplies the `x` SHA-256 hash)
 * 2. Raw `.epub` URL in content (kind 1)
 * 3. Kind 1063 file metadata with `m application/epub+zip` (handled in FileMetadataProcessor)
 *
 * Pure logic — unit-tested in epubDetection.test.ts.
 */

export const EPUB_MIME = 'application/epub+zip';

/** Regex for matching EPUB URLs in text (global, for extraction) */
export const EPUB_URL_REGEX = /https?:\/\/[^\s]+\.epub(?:[?&][^\s]*)?/gi;

/** Check if a string is an EPUB URL (single URL, optional query params) */
export function isEpubUrl(url: string): boolean {
  return /^https?:\/\/[^\s]+\.epub(?:\?[^\s]*)?$/i.test(url.trim());
}

/**
 * Feature detect for the reader engine: foliate-js needs DecompressionStream
 * (Chromium 80+, 2020). On older WebViews the book card falls back to the
 * download button only — the reader route must never be opened.
 */
export function isEpubReaderSupported(): boolean {
  return typeof DecompressionStream !== 'undefined';
}

/** An EPUB entry parsed out of a NIP-92 imeta tag */
export interface EpubImetaEntry {
  url: string;
  /** SHA-256 of the file (imeta `x` sub-tag) — stable key for reading progress */
  hash?: string;
}

/**
 * Parse NIP-92 `imeta` tags and return EPUB entries (those with
 * `m application/epub+zip`). Only `url` and `x` sub-tags are read.
 */
export function extractEpubImetaEntries(tags: string[][]): EpubImetaEntry[] {
  const entries: EpubImetaEntry[] = [];
  for (const tag of tags) {
    if (tag[0] !== 'imeta') continue;
    let url = '';
    let hash: string | undefined;
    let isEpub = false;
    for (let i = 1; i < tag.length; i++) {
      const prop = tag[i];
      if (!prop) continue;
      const spaceIndex = prop.indexOf(' ');
      if (spaceIndex === -1) continue;
      const key = prop.substring(0, spaceIndex);
      const value = prop.substring(spaceIndex + 1);
      if (key === 'url') url = value;
      else if (key === 'm' && value.toLowerCase() === EPUB_MIME) isEpub = true;
      else if (key === 'x') hash = value;
    }
    if (isEpub && url) entries.push(hash ? { url, hash } : { url });
  }
  return entries;
}

/** Extract a display file name from an EPUB URL */
export function extractEpubFileName(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/');
    const name = decodeURIComponent(segments[segments.length - 1] || 'book');
    return name || 'book';
  } catch {
    return 'book';
  }
}
