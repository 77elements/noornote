/**
 * Tests for parseCurationSetEvent (kind 30004 — NIP-51 article curation
 * set, e.g. Zap Cooking Recipe Packs). Covers tag extraction, `a`-tag
 * reference parsing (relay hints, dedupe, invalid coords) and external
 * URL extraction from the content.
 */

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { parseCurationSetEvent, CURATION_SET_KIND } from './parseCurationSet';

function fakeEvent(
  overrides: Partial<NostrEvent> & { tags?: string[][] }
): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1791286665,
    kind: CURATION_SET_KIND,
    tags: [],
    content: '',
    sig: 'c'.repeat(128),
    ...overrides,
  } as unknown as NostrEvent;
}

const PACK_TAGS = [
  ['d', 'zapcooking-my-recipes'],
  ['title', "Jimble's Jumble's Recipes"],
  ['description', 'A collection of recipes shared by Jimble.'],
  ['image', 'https://image.nostr.build/cover.jpg'],
  ['t', 'recipe-pack'],
  ['a', '30023:aa02:overnight-oats', 'wss://relay.damus.io'],
  ['a', '30023:aa02:tuna-bowl', 'wss://relay.primal.net'],
  ['a', '30023:aa02:overnight-oats', 'wss://other.relay'],
  ['a', '1:aa02:not-addressable'],
  ['a', '99999:aa02:out-of-range'],
  ['a', '30023:aa02'],
  ['a', ''],
];

describe('parseCurationSetEvent', () => {
  it('extracts metadata tags', () => {
    const set = parseCurationSetEvent(fakeEvent({ tags: PACK_TAGS }));
    expect(set.id).toBe('zapcooking-my-recipes');
    expect(set.title).toBe("Jimble's Jumble's Recipes");
    expect(set.description).toBe('A collection of recipes shared by Jimble.');
    expect(set.coverImage).toBe('https://image.nostr.build/cover.jpg');
    expect(set.authorPubkey).toBe('b'.repeat(64));
    expect(set.createdAt).toBe(1791286665);
  });

  it('parses addressable a-tag refs, keeping the first relay hint', () => {
    const set = parseCurationSetEvent(fakeEvent({ tags: PACK_TAGS }));
    expect(set.itemRefs).toEqual([
      {
        kind: 30023,
        pubkey: 'aa02',
        identifier: 'overnight-oats',
        relay: 'wss://relay.damus.io',
      },
      {
        kind: 30023,
        pubkey: 'aa02',
        identifier: 'tuna-bowl',
        relay: 'wss://relay.primal.net',
      },
    ]);
  });

  it('skips invalid a-tags (non-addressable kinds, malformed, empty)', () => {
    const set = parseCurationSetEvent(fakeEvent({ tags: PACK_TAGS }));
    expect(set.itemRefs.some(r => r.kind === 1)).toBe(false);
    expect(set.itemRefs.some(r => r.kind === 99999)).toBe(false);
    expect(set.itemRefs.length).toBe(2);
  });

  it('falls back to a default title and empty fields', () => {
    const set = parseCurationSetEvent(fakeEvent());
    expect(set.title).toBe('Untitled collection');
    expect(set.id).toBe('');
    expect(set.coverImage).toBe('');
    expect(set.itemRefs).toEqual([]);
    expect(set.externalUrl).toBe('');
  });

  it('extracts the first content link as external URL', () => {
    const set = parseCurationSetEvent(
      fakeEvent({
        content:
          'I made a Recipe Pack on Zap Cooking: Test\n\nIncludes 2 recipes. Open it:\nhttps://zap.cooking/pack/naddr1qvzqq',
      })
    );
    expect(set.externalUrl).toBe('https://zap.cooking/pack/naddr1qvzqq');
  });

  it('strips trailing punctuation from the external URL', () => {
    const set = parseCurationSetEvent(
      fakeEvent({ content: 'See https://zap.cooking/pack/x1.' })
    );
    expect(set.externalUrl).toBe('https://zap.cooking/pack/x1');
  });
});
