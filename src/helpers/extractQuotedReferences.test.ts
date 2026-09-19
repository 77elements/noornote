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
import { extractQuotedReferences } from './extractQuotedReferences';
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
