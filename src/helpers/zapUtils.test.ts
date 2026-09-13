// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import {
  buildZapOnZapPreview,
  buildZapReactionEntries,
  extractZapperPubkey,
  extractZapMessage,
  formatNumberWithCommas,
  formatSatsCompact,
  getZapAmountSats,
  isZapAnonymous,
  parseBolt11Amount,
} from './zapUtils';

function receipt(
  tags: string[][],
  overrides: Partial<NostrEvent> = {}
): NostrEvent {
  return {
    id: 'receipt-id',
    pubkey: 'node-pubkey',
    sig: '',
    kind: 9735,
    created_at: 1700000000,
    tags,
    content: '',
    ...overrides,
  } as NostrEvent;
}

function zapRequestJson(
  pubkey: string,
  tags: string[][] = [],
  content = ''
): string {
  return JSON.stringify({ kind: 9734, created_at: 1, tags, content, pubkey });
}

describe('parseBolt11Amount', () => {
  it('parses milli (m) multiplier to sats', () => {
    // 21 mBTC = 2,100,000 sats
    expect(parseBolt11Amount('lnbc21m1qjwtsw0g')).toBe(2_100_000);
  });

  it('parses micro (u) multiplier to sats', () => {
    // 2100 uBTC = 210,000 sats
    expect(parseBolt11Amount('lnbc2100u1qsjjvw')).toBe(210_000);
  });

  it('parses nano (n) multiplier to sats', () => {
    // 100,000 nBTC = 10,000 sats
    expect(parseBolt11Amount('lnbc100000n1qsjjvw')).toBe(10_000);
  });

  it('parses pico (p) multiplier to sats', () => {
    // 1,000,000 pBTC = 100 sats
    expect(parseBolt11Amount('lnbc1000000p1qsjjvw')).toBe(100);
  });

  it('parses default (BTC) multiplier to sats', () => {
    // 21 BTC = 2,100,000,000 sats
    expect(parseBolt11Amount('lnbc21q1sjjvw')).toBe(2_100_000_000);
  });

  it('matches testnet (lntb) prefixes', () => {
    expect(parseBolt11Amount('lntb210u1psjjvw')).toBe(21_000);
  });

  it('returns 0 for invoices without an amount', () => {
    expect(parseBolt11Amount('lnbc1psjjvw')).toBe(0);
  });

  it('returns 0 for non-bolt11 strings', () => {
    expect(parseBolt11Amount('not-an-invoice')).toBe(0);
    expect(parseBolt11Amount('')).toBe(0);
  });
});

describe('getZapAmountSats', () => {
  it('extracts the amount from the bolt11 tag', () => {
    const event = receipt([['bolt11', 'lnbc210u1psjjvw']]);
    expect(getZapAmountSats(event)).toBe(21_000);
  });

  it('returns 0 when no bolt11 tag exists', () => {
    expect(getZapAmountSats(receipt([]))).toBe(0);
  });

  it('returns 0 when the bolt11 tag carries no amount', () => {
    const event = receipt([['bolt11', 'lnbc1psjjvw']]);
    expect(getZapAmountSats(event)).toBe(0);
  });
});

describe('isZapAnonymous', () => {
  it('detects the anon tag (empty value = pure anonymous)', () => {
    const event = receipt([
      ['description', zapRequestJson('eph-key', [['anon', '']])],
    ]);
    expect(isZapAnonymous(event)).toBe(true);
  });

  it('detects the anon tag with a value (DIP-03 private zap)', () => {
    const event = receipt([
      ['description', zapRequestJson('eph-key', [['anon', 'secret']])],
    ]);
    expect(isZapAnonymous(event)).toBe(true);
  });

  it('returns false for a normal zap request', () => {
    const event = receipt([
      ['description', zapRequestJson('real-key', [['p', 'target']])],
    ]);
    expect(isZapAnonymous(event)).toBe(false);
  });

  it('returns false when the description tag is missing', () => {
    expect(isZapAnonymous(receipt([]))).toBe(false);
  });

  it('returns false for malformed description JSON', () => {
    const event = receipt([['description', 'not-json{']]);
    expect(isZapAnonymous(event)).toBe(false);
  });

  it('returns false when the request has no tags array', () => {
    const event = receipt([['description', JSON.stringify({ pubkey: 'x' })]]);
    expect(isZapAnonymous(event)).toBe(false);
  });
});

describe('extractZapperPubkey', () => {
  it('prefers the P tag over the description pubkey', () => {
    const event = receipt([
      ['P', 'p-tag-key'],
      ['description', zapRequestJson('desc-key')],
    ]);
    expect(extractZapperPubkey(event)).toBe('p-tag-key');
  });

  it('falls back to the description zap-request pubkey', () => {
    const event = receipt([['description', zapRequestJson('desc-key')]]);
    expect(extractZapperPubkey(event)).toBe('desc-key');
  });

  it('falls back to the event pubkey when nothing else exists', () => {
    expect(extractZapperPubkey(receipt([]))).toBe('node-pubkey');
  });
});

describe('extractZapMessage', () => {
  it('returns the zap request content as message', () => {
    const event = receipt([
      ['description', zapRequestJson('key', [], 'great post!')],
    ]);
    expect(extractZapMessage(event)).toBe('great post!');
  });

  it('returns empty string when the request has no content', () => {
    const event = receipt([['description', zapRequestJson('key')]]);
    expect(extractZapMessage(event)).toBe('');
  });

  it('returns empty string when the description tag is missing', () => {
    expect(extractZapMessage(receipt([]))).toBe('');
  });

  it('returns empty string for malformed description JSON', () => {
    const event = receipt([['description', 'not-json{']]);
    expect(extractZapMessage(event)).toBe('');
  });
});

describe('formatSatsCompact', () => {
  it('passes through amounts below 1000', () => {
    expect(formatSatsCompact(999)).toBe('999');
    expect(formatSatsCompact(0)).toBe('0');
  });

  it('compacts thousands with one decimal', () => {
    expect(formatSatsCompact(1_500)).toBe('1.5k');
    expect(formatSatsCompact(11_200)).toBe('11.2k');
  });

  it('trims a trailing .0', () => {
    expect(formatSatsCompact(1_000)).toBe('1k');
    expect(formatSatsCompact(10_000)).toBe('10k');
  });

  it('compacts millions', () => {
    expect(formatSatsCompact(1_000_000)).toBe('1M');
    expect(formatSatsCompact(1_120_000)).toBe('1.1M');
  });
});

describe('formatNumberWithCommas', () => {
  it('formats with US thousands separators', () => {
    expect(formatNumberWithCommas(1_500)).toBe('1,500');
    expect(formatNumberWithCommas(1_000_000)).toBe('1,000,000');
  });

  it('passes through small numbers unchanged', () => {
    expect(formatNumberWithCommas(21)).toBe('21');
  });
});

describe('buildZapReactionEntries', () => {
  function reaction(
    id: string,
    pubkey: string,
    content: string,
    tags: string[][] = []
  ): NostrEvent {
    return {
      id,
      kind: 7,
      pubkey,
      created_at: 1,
      tags,
      content,
      sig: '',
    } as NostrEvent;
  }

  it('maps one entry per reaction with the reactor pubkey', () => {
    const entries = buildZapReactionEntries([
      reaction('r1', 'cody', '💜'),
      reaction('r2', 'bob', '👍'),
    ]);
    expect(entries).toEqual([
      { emojiHtml: '💜', pubkey: 'cody' },
      { emojiHtml: '👍', pubkey: 'bob' },
    ]);
  });

  it('maps "+" and empty content to ❤️ (ISL/LikesList convention)', () => {
    const entries = buildZapReactionEntries([
      reaction('r1', 'cody', '+'),
      reaction('r2', 'bob', ''),
    ]);
    expect(entries.map(e => e.emojiHtml)).toEqual(['❤️', '❤️']);
  });

  it('skips downvotes and entries without a pubkey', () => {
    const entries = buildZapReactionEntries([
      reaction('r1', 'cody', '-'),
      reaction('r2', '', '💜'),
      reaction('r3', 'bob', '👍'),
    ]);
    expect(entries).toEqual([{ emojiHtml: '👍', pubkey: 'bob' }]);
  });

  it('escapes crafted content (XSS-safe output)', () => {
    const entries = buildZapReactionEntries([
      reaction('r1', 'cody', '<img src=x onerror=alert(1)>'),
    ]);
    expect(entries[0]!.emojiHtml).not.toContain('<img');
    expect(entries[0]!.emojiHtml).toContain('&lt;img');
  });

  it('resolves NIP-30 custom emojis to an img tag', () => {
    const entries = buildZapReactionEntries([
      reaction('r1', 'cody', ':noornote:', [
        ['emoji', 'noornote', 'https://emo.test/noornote.png'],
      ]),
    ]);
    expect(entries[0]!.emojiHtml).toContain('<img');
    expect(entries[0]!.emojiHtml).toContain(
      'src="https://emo.test/noornote.png"'
    );
  });

  it('returns escaped shortcode text when no matching emoji tag exists', () => {
    const entries = buildZapReactionEntries([
      reaction('r1', 'cody', ':ghost:'),
    ]);
    expect(entries[0]!.emojiHtml).toBe(':ghost:');
  });
});

describe('buildZapOnZapPreview', () => {
  it('formats amount and note snippet', () => {
    expect(buildZapOnZapPreview(1_000, 'hello world')).toBe(
      '⚡ 1,000 sats zap on "hello world"'
    );
  });

  it('falls back to the bare zap when the note is unfetchable', () => {
    expect(buildZapOnZapPreview(1_000, null)).toBe('⚡ 1,000 sats zap');
    expect(buildZapOnZapPreview(1_000, '   ')).toBe('⚡ 1,000 sats zap');
  });

  it('uses "a zap" when the receipt carries no bolt11 amount', () => {
    expect(buildZapOnZapPreview(0, 'nice')).toBe('⚡ a zap on "nice"');
  });

  it('truncates long snippets at 80 chars with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const preview = buildZapOnZapPreview(21, long);
    expect(preview).toBe(`⚡ 21 sats zap on "${'x'.repeat(80)}…"`);
  });

  it('collapses whitespace in the snippet', () => {
    expect(buildZapOnZapPreview(5, 'a\n\n  b\tc')).toBe(
      '⚡ 5 sats zap on "a b c"'
    );
  });
});
