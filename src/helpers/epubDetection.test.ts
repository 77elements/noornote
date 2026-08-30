/**
 * Regression tests for EPUB detection (docs/todos/epub-reader.md).
 * Covers: .epub URL detection via extractMedia, NIP-92 imeta parsing
 * (m application/epub+zip → hash enrichment + extension-less URLs),
 * and display-name extraction.
 */

import { describe, it, expect } from 'vitest';
import {
  isEpubUrl,
  isEpubReaderSupported,
  extractEpubImetaEntries,
  extractEpubFileName,
  EPUB_URL_REGEX,
} from './epubDetection';
import { extractMedia, extractMediaWithImeta } from './extractMedia';

const EXAMPLE_URL = 'https://d.nostr.build/x0Vip1fC0beUJSfCc44EGD.epub';
const EXAMPLE_HASH =
  'd8b546ee5016cca0750d92538e254e63124e0d9fa74e486320488a69fbf674b8';

/** The kind-1 event from docs/todos/epub-reader.md, reduced to tags */
const EXAMPLE_TAGS: string[][] = [
  [
    'imeta',
    `url ${EXAMPLE_URL}`,
    'm application/epub+zip',
    `x ${EXAMPLE_HASH}`,
  ],
  ['r', EXAMPLE_URL],
];

describe('isEpubUrl', () => {
  it('accepts plain .epub URLs', () => {
    expect(isEpubUrl(EXAMPLE_URL)).toBe(true);
  });

  it('accepts .epub URLs with query params', () => {
    expect(isEpubUrl('https://host.example/book.epub?v=2')).toBe(true);
  });

  it('is case-insensitive on the extension', () => {
    expect(isEpubUrl('https://host.example/BOOK.EPUB')).toBe(true);
  });

  it('rejects non-epub URLs', () => {
    expect(isEpubUrl('https://host.example/image.jpg')).toBe(false);
    expect(isEpubUrl('not a url')).toBe(false);
  });
});

describe('EPUB_URL_REGEX', () => {
  it('matches an epub URL with trailing params without eating the next word', () => {
    const text = `Read this: https://host.example/a.epub?dl=1 now`;
    const matches = text.match(EPUB_URL_REGEX) ?? [];
    expect(matches).toEqual(['https://host.example/a.epub?dl=1']);
  });
});

describe('extractMedia — .epub URL detection', () => {
  it('creates an epub media item from a raw .epub URL in the text', () => {
    const media = extractMedia(`I wonder how this will work 📚 ${EXAMPLE_URL}`);
    const epub = media.find(m => m.type === 'epub');
    expect(epub).toBeDefined();
    expect(epub?.url).toBe(EXAMPLE_URL);
    expect(epub?.originalUrl).toBe(EXAMPLE_URL);
  });

  it('does not misclassify image/video URLs as epub', () => {
    const media = extractMedia('https://host.example/pic.jpg');
    expect(media.find(m => m.type === 'epub')).toBeUndefined();
  });
});

describe('extractEpubImetaEntries', () => {
  it('parses the NIP-92 imeta example (url + m + x)', () => {
    expect(extractEpubImetaEntries(EXAMPLE_TAGS)).toEqual([
      { url: EXAMPLE_URL, hash: EXAMPLE_HASH },
    ]);
  });

  it('ignores non-epub imeta tags (image/video)', () => {
    const tags = [
      ['imeta', 'url https://host.example/pic.jpg', 'm image/jpeg'],
    ];
    expect(extractEpubImetaEntries(tags)).toEqual([]);
  });

  it('tolerates a missing x hash', () => {
    const tags = [['imeta', `url ${EXAMPLE_URL}`, 'm application/epub+zip']];
    expect(extractEpubImetaEntries(tags)).toEqual([{ url: EXAMPLE_URL }]);
  });
});

describe('extractMediaWithImeta — enrichment', () => {
  it('enriches the .epub item with the imeta x hash', () => {
    const media = extractMediaWithImeta(
      `Check this 📚🥸 ${EXAMPLE_URL}`,
      EXAMPLE_TAGS
    );
    const epub = media.find(m => m.type === 'epub');
    expect(epub?.hash).toBe(EXAMPLE_HASH);
  });

  it('adds an imeta-declared epub whose URL lacks the .epub extension', () => {
    const bareUrl = 'https://cdn.example.net/abc123';
    const tags = [
      [
        'imeta',
        `url ${bareUrl}`,
        'm application/epub+zip',
        `x ${EXAMPLE_HASH}`,
      ],
    ];
    const media = extractMediaWithImeta(`Get it here ${bareUrl}`, tags);
    const epub = media.find(m => m.type === 'epub');
    expect(epub?.url).toBe(bareUrl);
    expect(epub?.hash).toBe(EXAMPLE_HASH);
  });

  it('ignores imeta epub entries whose URL is not in the content (NIP-92 rule)', () => {
    const media = extractMediaWithImeta('no url here', EXAMPLE_TAGS);
    expect(media.find(m => m.type === 'epub')).toBeUndefined();
  });
});

describe('extractEpubFileName', () => {
  it('extracts the file name', () => {
    expect(extractEpubFileName(EXAMPLE_URL)).toBe(
      'x0Vip1fC0beUJSfCc44EGD.epub'
    );
  });

  it('decodes encoded names', () => {
    expect(extractEpubFileName('https://host.example/My%20Book.epub')).toBe(
      'My Book.epub'
    );
  });

  it('falls back to "book" on garbage', () => {
    expect(extractEpubFileName('::::')).toBe('book');
  });
});

describe('isEpubReaderSupported', () => {
  it('returns a boolean without throwing', () => {
    expect(typeof isEpubReaderSupported()).toBe('boolean');
  });
});
