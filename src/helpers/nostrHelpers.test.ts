import { describe, it, expect } from 'vitest';
import { getTag, getTagValues } from './tagUtils';
import { getAddressableIdentifier } from './getAddressableIdentifier';
import { hexToNpub, npubToHex } from './nip19';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

const TAGS = [['d', 'slug'], ['title', 'Hello'], ['title', 'Second']] as string[][];

describe('tagUtils', () => {
  it('getTag returns the first matching tag value', () => {
    expect(getTag(TAGS, 'd')).toBe('slug');
    expect(getTag(TAGS, 'title')).toBe('Hello');
  });

  it('getTag falls back on missing tag/undefined tags', () => {
    expect(getTag(TAGS, 'nope')).toBe('');
    expect(getTag(TAGS, 'nope', 'x')).toBe('x');
    expect(getTag(undefined, 'd')).toBe('');
  });

  it('getTagValues collects every value of a repeated tag', () => {
    expect(getTagValues(TAGS, 'title')).toEqual(['Hello', 'Second']);
    expect(getTagValues(TAGS, 'nope')).toEqual([]);
  });
});

describe('getAddressableIdentifier', () => {
  const ev = (kind: number | undefined, d?: string) =>
    ({ kind, pubkey: 'pk', tags: d ? [['d', d]] : [] } as unknown as NostrEvent);

  it('builds kind:pubkey:d-tag for addressable kinds', () => {
    expect(getAddressableIdentifier(ev(30023, 'slug'))).toBe('30023:pk:slug');
  });

  it('rejects non-addressable kinds and missing d-tags', () => {
    expect(getAddressableIdentifier(ev(1, 'slug'))).toBeNull();
    expect(getAddressableIdentifier(ev(39999 + 1, 'slug'))).toBeNull();
    expect(getAddressableIdentifier(ev(30023))).toBeNull();
  });
});

describe('nip19 round-trips', () => {
  it('hex ↔ npub conversion is lossless and validates checksum', () => {
    const hex = 'ab'.repeat(32);
    const npub = hexToNpub(hex);
    expect(npub).toMatch(/^npub1[02-9ac-z]+$/);
    expect(npubToHex(npub!)).toBe(hex);
  });

  it('rejects invalid inputs instead of throwing', () => {
    expect(hexToNpub('not-hex')).toBeNull();
    expect(npubToHex('npub1invalid')).toBeNull();
  });
});
