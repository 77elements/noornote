/**
 * Regression tests for extractQuotedReferences / NOSTR_EVENT_REF_REGEX.
 *
 * 2026-09: a kind-1 note linking `https://…/?naddr=naddr1…` produced
 * (1) a false quote card for the naddr in the query param and (2) corrupted
 * HTML, because formatQuotedReferences replaced the token inside the already
 * linkified <a href="…"> attribute. The lookbehinds `(?<!\/)` + `(?<![?&=])`
 * must keep the regex out of URLs entirely.
 */

import { describe, it, expect } from 'vitest';
import {
  extractQuotedReferences,
  enrichQuoteAuthorHints,
} from './extractQuotedReferences';
import { unwrapStreamLinks } from './unwrapStreamLinks';
import {
  encodeNevent,
  encodeNaddr,
  noteEncode,
} from '../services/NostrToolsAdapter';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

describe('extractQuotedReferences', () => {
  it('still quotes NIP-19 path URLs via unwrapStreamLinks (satellite.earth/thread style)', () => {
    const note = noteEncode(HEX_A);
    const unwrapped = unwrapStreamLinks(
      `https://satellite.earth/thread/${note}`
    );
    const refs = extractQuotedReferences(unwrapped);
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe('note');
  });

  it('still quotes zap.stream naddr URLs via unwrapStreamLinks', () => {
    const naddr = encodeNaddr({
      kind: 30311,
      pubkey: HEX_B,
      identifier: 'stream',
    });
    const refs = extractQuotedReferences(
      unwrapStreamLinks(`https://zap.stream/${naddr}`)
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe('addr');
  });

  it('unwraps budabit-style URLs with the naddr mid-path (trailing path segments swallowed)', () => {
    // budabit.club puts the naddr in the middle of the path:
    // https://budabit.club/c/<naddr>/calendar — the trailing /calendar is
    // site chrome and must NOT dangle as text next to the quote card.
    const naddr = encodeNaddr({
      kind: 32222,
      pubkey: HEX_B,
      identifier: `${'c'.repeat(63)}d`,
    });
    const unwrapped = unwrapStreamLinks(
      `Join us https://budabit.club/c/${naddr}/calendar for details`
    );
    expect(unwrapped).toBe(`Join us nostr:${naddr} for details`);
    const refs = extractQuotedReferences(unwrapped);
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe('addr');
  });
  it('ignores an naddr inside a URL query param (real-world false positive)', () => {
    const naddr = encodeNaddr({
      kind: 35129,
      pubkey: HEX_B,
      identifier: 'nostr-pet',
    });
    const content = `I really like my nappagochi but please try\n\nhttps://kehto.github.io/web/paja/?naddr=${naddr}\n\ntext after`;
    expect(extractQuotedReferences(content)).toEqual([]);
  });

  it('ignores npub/naddr inside an already-linkified anchor (href + text)', () => {
    const naddr = encodeNaddr({
      kind: 32267,
      pubkey: HEX_B,
      identifier: 'app',
    });
    const url = `https://example.com/web/app/?naddr=${naddr}`;
    const html = `<a href="${url}" rel="noopener">${url}</a>`;
    expect(extractQuotedReferences(html)).toEqual([]);
  });

  it('ignores refs inside URL paths (path-lookbehind guard)', () => {
    const nevent = encodeNevent(HEX_A, [], HEX_A);
    expect(extractQuotedReferences(`https://example.com/e/${nevent}`)).toEqual(
      []
    );
  });

  it('still extracts a nostr:nevent quote', () => {
    const nevent = encodeNevent(HEX_A, [], HEX_A);
    const refs = extractQuotedReferences(`look: nostr:${nevent}`);
    expect(refs).toHaveLength(1);
    // Type is 'event' — the classifier keys on the `event1` substring inside
    // `nevent1` (pre-existing behavior; ContentProcessor only distinguishes
    // event/note/addr, which is unaffected).
    expect(refs[0].type).toBe('event');
  });

  it('still extracts a bare note1 reference', () => {
    const note = noteEncode(HEX_A);
    const refs = extractQuotedReferences(`check ${note} out`);
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe('note');
  });

  it('still extracts a bare naddr reference at word start', () => {
    const naddr = encodeNaddr({
      kind: 39089,
      pubkey: HEX_B,
      identifier: 'pack',
    });
    const refs = extractQuotedReferences(`${naddr} is a follow pack`);
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe('addr');
  });

  it('still captures an naddr #fragment (armada invites)', () => {
    const naddr = encodeNaddr({
      kind: 33301,
      pubkey: HEX_B,
      identifier: 'invite',
    });
    const refs = extractQuotedReferences(`${naddr}#BAHcYKk`);
    expect(refs).toHaveLength(1);
    expect(refs[0].fragment).toBe('BAHcYKk');
  });
});

/**
 * 2026-11: quoted-repost case that failed to resolve in production. A bare
 * `nostr:note1…` quote embeds neither author nor relay hints, so the quote
 * pipeline's outbound fallback only knew the quoter's relays — but the quoted
 * event lives on the quoted author's write relays. The author is sitting in
 * the parent's `q`/`p` tags; enrichQuoteAuthorHints must surface it.
 */
describe('enrichQuoteAuthorHints', () => {
  const QUOTED_ID = 'c'.repeat(64);
  const QUOTED_AUTHOR =
    'a0e73529e04b4970a185e864b89e7d6e1ed148fdf08381b540ac020a742c62d5';
  const QUOTER =
    '30e0a129606706a5c10530224cab84f4f6624b1f1b8418ac651c5156cf2e0194';

  it('bare note1 + NIP-18 q tag with author element → hint from q[3]', () => {
    const refs = extractQuotedReferences(`look nostr:${noteEncode(QUOTED_ID)}`);
    enrichQuoteAuthorHints(refs, [
      ['q', QUOTED_ID, 'wss://relay.example', QUOTED_AUTHOR],
      ['p', QUOTED_AUTHOR],
    ]);
    expect(refs[0].authorHints).toEqual([QUOTED_AUTHOR]);
  });

  it('bare note1 + author-less q tag → fallback to parent p tags', () => {
    const refs = extractQuotedReferences(`look ${noteEncode(QUOTED_ID)}`);
    enrichQuoteAuthorHints(refs, [
      ['e', QUOTED_ID, '', 'mention'],
      ['p', QUOTED_AUTHOR],
      ['q', QUOTED_ID],
    ]);
    expect(refs[0].authorHints).toEqual([QUOTED_AUTHOR]);
  });

  it('nevent with embedded author is left alone (orchestrator prefers it)', () => {
    const refs = extractQuotedReferences(
      `look ${encodeNevent(QUOTED_ID, [], QUOTED_AUTHOR)}`
    );
    enrichQuoteAuthorHints(refs, [['p', QUOTER]]);
    expect(refs[0].authorHints).toBeUndefined();
  });

  it('author-less nevent gets the p-tag fallback like bare refs', () => {
    const refs = extractQuotedReferences(`look ${encodeNevent(QUOTED_ID)}`);
    enrichQuoteAuthorHints(refs, [['p', QUOTED_AUTHOR]]);
    expect(refs[0].authorHints).toEqual([QUOTED_AUTHOR]);
  });

  it('ambiguous pairing (several q tags) falls back to the p-tag union', () => {
    const idA = 'd'.repeat(64);
    const refs = extractQuotedReferences(
      `a ${noteEncode(QUOTED_ID)} b ${noteEncode(idA)}`
    );
    enrichQuoteAuthorHints(refs, [
      ['q', QUOTED_ID],
      ['q', idA],
      ['p', QUOTED_AUTHOR],
      ['p', QUOTER],
    ]);
    expect(refs[0].authorHints).toEqual([QUOTED_AUTHOR, QUOTER]);
    expect(refs[1].authorHints).toEqual([QUOTED_AUTHOR, QUOTER]);
  });

  it('no q/p tags in parent → no hints', () => {
    const refs = extractQuotedReferences(`look ${noteEncode(QUOTED_ID)}`);
    enrichQuoteAuthorHints(refs, [['t', 'nostr']]);
    expect(refs[0].authorHints).toBeUndefined();
  });
});
