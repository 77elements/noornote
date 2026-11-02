import { describe, it, expect } from 'vitest';
import {
  parseBlossomUri,
  blobUrlFor,
  renderTypeForExt,
  renderTypeForContentType,
  normalizeBlossomServer,
  BLOSSOM_URI_REGEX,
} from './blossomUri';

const HASH = 'b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553';

describe('parseBlossomUri', () => {
  it('parses the minimal spec form (hash only)', () => {
    const uri = parseBlossomUri(`blossom:${HASH}`);
    expect(uri).not.toBeNull();
    expect(uri!.hash).toBe(HASH);
    expect(uri!.raw).toBe(`blossom:${HASH}`);
    expect(uri!.ext).toBeUndefined();
    expect(uri!.servers).toEqual([]);
    expect(uri!.authors).toEqual([]);
    expect(uri!.size).toBeUndefined();
  });

  it('parses hash + extension', () => {
    const uri = parseBlossomUri(`blossom:${HASH}.pdf`);
    expect(uri!.hash).toBe(HASH);
    expect(uri!.ext).toBe('pdf');
  });

  it('parses xs, as and sz parameters (repeatable xs/as)', () => {
    const uri = parseBlossomUri(
      `blossom:${HASH}.pdf?xs=cdn.example.com&xs=backup.example.com&as=${HASH}&as=${'A'.padEnd(64, '0')}&sz=184292`
    );
    expect(uri!.servers).toEqual([
      'https://cdn.example.com',
      'https://backup.example.com',
    ]);
    expect(uri!.authors).toEqual([HASH, 'a'.padEnd(64, '0')]);
    expect(uri!.size).toBe(184292);
  });

  it('normalizes uppercase hashes to lowercase', () => {
    const upper = HASH.toUpperCase();
    const uri = parseBlossomUri(`blossom:${upper}`);
    expect(uri!.hash).toBe(HASH.toLowerCase());
  });

  it('tolerates the blossom:// double-slash form', () => {
    const uri = parseBlossomUri(`blossom://${HASH}.png`);
    expect(uri).not.toBeNull();
    expect(uri!.raw).toBe(`blossom:${HASH}.png`);
    expect(uri!.ext).toBe('png');
  });

  it('rejects a too-short hash', () => {
    expect(parseBlossomUri(`blossom:${HASH.slice(0, 63)}`)).toBeNull();
  });

  it('rejects a non-hex hash', () => {
    expect(
      parseBlossomUri(
        'blossom:zzzz4191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f55'
      )
    ).toBeNull();
  });

  it('rejects unrelated text', () => {
    expect(parseBlossomUri('https://example.com/image.png')).toBeNull();
    expect(parseBlossomUri('')).toBeNull();
  });

  it('ignores invalid sz but keeps the URI valid', () => {
    const uri = parseBlossomUri(`blossom:${HASH}?sz=abc`);
    expect(uri!.size).toBeUndefined();
  });

  it('dedupes repeated identical xs hints', () => {
    const uri = parseBlossomUri(
      `blossom:${HASH}?xs=cdn.example.com&xs=https://cdn.example.com`
    );
    expect(uri!.servers).toEqual(['https://cdn.example.com']);
  });

  it('drops path-carrying server hints (origin-only rule)', () => {
    const uri = parseBlossomUri(
      `blossom:${HASH}?xs=https://evil.com/path?blob=${HASH}`
    );
    expect(uri!.servers).toEqual([]);
  });
});

describe('BLOSSOM_URI_REGEX extraction', () => {
  it('finds a URI inside prose and stops at whitespace', () => {
    const text = `look at this blossom:${HASH}.jpg?xs=a.com nice`;
    BLOSSOM_URI_REGEX.lastIndex = 0;
    const matches = text.match(BLOSSOM_URI_REGEX);
    expect(matches).toEqual([`blossom:${HASH}.jpg?xs=a.com`]);
  });

  it('does not match https URLs', () => {
    BLOSSOM_URI_REGEX.lastIndex = 0;
    expect(
      'https://example.com/b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.png'.match(
        BLOSSOM_URI_REGEX
      )
    ).toBeNull();
  });
});

describe('normalizeBlossomServer', () => {
  it('prepends https:// when scheme is missing', () => {
    expect(normalizeBlossomServer('cdn.example.com')).toBe(
      'https://cdn.example.com'
    );
  });

  it('strips trailing slashes and lowercases host', () => {
    expect(normalizeBlossomServer('HTTPS://CDN.Example.com///')).toBe(
      'https://cdn.example.com'
    );
  });

  it('rejects empty and garbage hints', () => {
    expect(normalizeBlossomServer('')).toBeNull();
    expect(normalizeBlossomServer('   ')).toBeNull();
    expect(normalizeBlossomServer('not a url ://')).toBeNull();
  });
});

describe('blobUrlFor', () => {
  it('builds BUD-01 GET URLs with .bin fallback for missing ext', () => {
    const info = parseBlossomUri(`blossom:${HASH}`)!;
    expect(blobUrlFor('https://cdn.example.com', info)).toBe(
      `https://cdn.example.com/${HASH}.bin`
    );
    const withExt = parseBlossomUri(`blossom:${HASH}.png`)!;
    expect(blobUrlFor('https://cdn.example.com/', withExt)).toBe(
      `https://cdn.example.com/${HASH}.png`
    );
  });
});

describe('renderType mapping', () => {
  it('maps extensions', () => {
    expect(renderTypeForExt('jpg')).toBe('image');
    expect(renderTypeForExt('MP4')).toBe('video');
    expect(renderTypeForExt('flac')).toBe('audio');
    expect(renderTypeForExt('epub')).toBe('epub');
    expect(renderTypeForExt(undefined)).toBe('image');
    expect(renderTypeForExt('bin')).toBe('image');
  });

  it('maps content types', () => {
    expect(renderTypeForContentType('image/png')).toBe('image');
    expect(renderTypeForContentType('video/mp4')).toBe('video');
    expect(renderTypeForContentType('audio/ogg')).toBe('audio');
    expect(renderTypeForContentType('application/epub+zip')).toBe('epub');
    expect(renderTypeForContentType(null)).toBe('image');
  });
});
