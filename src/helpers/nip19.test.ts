/**
 * Regression tests for the mention/publish split in nip19.ts.
 *
 * `extractMentionPubkeysFromText` (used for NIP-10 p-tag mention tagging)
 * must ignore npub/nprofile tokens embedded in URLs — sharing a profile link
 * (`https://noornote.app/profile/npub1…`) never tags the linked person as
 * "mentioned". `extractPubkeysFromText` stays deliberately permissive: the
 * tribes member input extracts npubs from pasted profile URLs ON PURPOSE.
 */

import { describe, it, expect } from 'vitest';
import {
  extractPubkeysFromText,
  extractMentionPubkeysFromText,
  hexToNpub,
} from './nip19';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const npubA = hexToNpub(HEX_A) as string;
const npubB = hexToNpub(HEX_B) as string;

describe('extractMentionPubkeysFromText (URL-safe, p-tag tagging)', () => {
  it('ignores an npub inside a URL path', () => {
    const text = `Check https://noornote.app/profile/${npubA} out`;
    expect(extractMentionPubkeysFromText(text)).toEqual([]);
  });

  it('ignores an npub inside a URL query value', () => {
    const text = `See https://example.com/?npub=${npubA}&x=1`;
    expect(extractMentionPubkeysFromText(text)).toEqual([]);
  });

  it('ignores a nostr:-prefixed token inside a query value', () => {
    const text = `https://example.com/?send=nostr:${npubA}`;
    expect(extractMentionPubkeysFromText(text)).toEqual([]);
  });

  it('still extracts bare and nostr:-prefixed mentions in plain text', () => {
    const text = `hi ${npubA} and nostr:${npubB}`;
    const hexes = extractMentionPubkeysFromText(text);
    expect(hexes).toHaveLength(2);
    expect(hexes).toContain(HEX_A);
    expect(hexes).toContain(HEX_B);
  });
});

describe('extractPubkeysFromText (permissive, tribes member input)', () => {
  it('still extracts an npub from a pasted profile URL on purpose', () => {
    const text = `https://noornote.app/profile/${npubA}`;
    const hexes = extractPubkeysFromText(text);
    expect(hexes).toEqual([HEX_A]);
  });

  it('extracts bare mentions as before', () => {
    expect(extractPubkeysFromText(`plain ${npubB}`)).toEqual([HEX_B]);
  });
});
