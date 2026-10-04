/**
 * Tests for GIF helper logic (gifs.nostr.build integration):
 * query validation, media URL detection, and NIP-92 imeta tag construction.
 * Regression tests for the GIF picker feature.
 */

import { describe, expect, it } from 'vitest';
import {
  collectGifImetaTags,
  extractGifUrlsFromContent,
  gifFormatToMime,
  isGifMediaUrl,
  isSearchableGifQuery,
  type GifMeta,
} from './gifImeta';

describe('isSearchableGifQuery', () => {
  it('rejects empty and punctuation-only queries', () => {
    expect(isSearchableGifQuery('')).toBe(false);
    expect(isSearchableGifQuery('   ')).toBe(false);
    expect(isSearchableGifQuery('!!!')).toBe(false);
  });

  it('rejects a single Latin letter (noise, spends rate budget)', () => {
    expect(isSearchableGifQuery('a')).toBe(false);
    expect(isSearchableGifQuery('Z')).toBe(false);
  });

  it('accepts two letters and normal words', () => {
    expect(isSearchableGifQuery('ab')).toBe(true);
    expect(isSearchableGifQuery('cat')).toBe(true);
    expect(isSearchableGifQuery('good morning')).toBe(true);
  });

  it('accepts a single emoji and CJK/Hangul characters', () => {
    expect(isSearchableGifQuery('😂')).toBe(true);
    expect(isSearchableGifQuery('猫')).toBe(true);
    expect(isSearchableGifQuery('개')).toBe(true);
  });

  it('rejects a lone skin tone modifier (nothing without a base emoji)', () => {
    expect(isSearchableGifQuery('🏽')).toBe(false);
  });

  it('rejects queries over the 500 char API limit', () => {
    expect(isSearchableGifQuery('a'.repeat(501))).toBe(false);
    expect(isSearchableGifQuery('a'.repeat(500))).toBe(true);
  });
});

describe('isGifMediaUrl', () => {
  it('accepts the gifs.nostr.build host', () => {
    expect(isGifMediaUrl('https://gifs.nostr.build/abc.gif')).toBe(true);
  });

  it('rejects other hosts and impostor domains', () => {
    expect(isGifMediaUrl('https://evil.com/abc.gif')).toBe(false);
    expect(isGifMediaUrl('https://gifs.nostr.build.evil.com/abc.gif')).toBe(
      false
    );
    expect(isGifMediaUrl('http://gifs.nostr.build/abc.gif')).toBe(true); // scheme-agnostic host check
  });

  it('rejects garbage', () => {
    expect(isGifMediaUrl('not a url')).toBe(false);
    expect(isGifMediaUrl('')).toBe(false);
  });
});

describe('extractGifUrlsFromContent', () => {
  it('finds URLs in content in order', () => {
    const content = [
      'check this',
      'https://gifs.nostr.build/aaa.gif',
      'https://gifs.nostr.build/bbb.gif',
    ].join('\n\n');
    expect(extractGifUrlsFromContent(content)).toEqual([
      'https://gifs.nostr.build/aaa.gif',
      'https://gifs.nostr.build/bbb.gif',
    ]);
  });

  it('dedupes repeated URLs', () => {
    const content =
      'https://gifs.nostr.build/aaa.gif and https://gifs.nostr.build/aaa.gif';
    expect(extractGifUrlsFromContent(content)).toEqual([
      'https://gifs.nostr.build/aaa.gif',
    ]);
  });

  it('ignores non-GIF-host URLs', () => {
    const content = 'https://nostr.build/abc.gif https://example.com/x.gif';
    expect(extractGifUrlsFromContent(content)).toEqual([]);
  });

  it('returns nothing for content without URLs', () => {
    expect(extractGifUrlsFromContent('just text')).toEqual([]);
  });
});

describe('collectGifImetaTags', () => {
  const URL_A = 'https://gifs.nostr.build/aaa.gif';
  const URL_B = 'https://gifs.nostr.build/bbb.gif';

  const metaA: GifMeta = {
    m: 'image/gif',
    dim: '224x126',
    size: 806309,
    alt: 'Giant wave curling with an eye',
  };

  it('builds the guide-example imeta shape (url, m, dim, size, alt)', () => {
    const content = `nice one\n\n${URL_A}`;
    const tags = collectGifImetaTags(content, url =>
      url === URL_A ? metaA : undefined
    );
    expect(tags).toEqual([
      [
        'imeta',
        `url ${URL_A}`,
        'm image/gif',
        'dim 224x126',
        'size 806309',
        'alt Giant wave curling with an eye',
      ],
    ]);
  });

  it('omits size when bytes are null and alt when the title is empty', () => {
    const tags = collectGifImetaTags(URL_B, () => ({
      m: 'image/webp',
      dim: '360x203',
      size: null,
      alt: '',
    }));
    expect(tags).toEqual([
      ['imeta', `url ${URL_B}`, 'm image/webp', 'dim 360x203'],
    ]);
  });

  it('returns no tag for URLs without cached metadata (never picked)', () => {
    const content = `random pasted url ${URL_A}`;
    expect(collectGifImetaTags(content, () => undefined)).toEqual([]);
  });

  it('emits one tag per unique URL, in order, deduped', () => {
    const content = `${URL_A} ${URL_B} ${URL_A}`;
    const tags = collectGifImetaTags(content, url =>
      url === URL_A ? metaA : { m: 'image/gif', dim: '10x10' }
    );
    expect(tags).toHaveLength(2);
    expect(tags[0]![1]).toBe(`url ${URL_A}`);
    expect(tags[1]![1]).toBe(`url ${URL_B}`);
  });

  it('trims whitespace around alt', () => {
    const tags = collectGifImetaTags(URL_A, () => ({
      m: 'image/gif',
      dim: '1x1',
      alt: '  padded title  ',
    }));
    expect(tags[0]!.at(-1)).toBe('alt padded title');
  });
});

describe('gifFormatToMime', () => {
  it('maps gif and webp formats', () => {
    expect(gifFormatToMime('gif')).toBe('image/gif');
    expect(gifFormatToMime('webp')).toBe('image/webp');
  });

  it('falls back to image/gif for unknown formats', () => {
    expect(gifFormatToMime('png')).toBe('image/gif');
  });
});
