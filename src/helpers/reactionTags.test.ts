import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { buildReactionTags } from './reactionTags';

const AUTHOR = 'a'.repeat(64);
const NOTE = 'c'.repeat(64);
const SENDER = 'f'.repeat(64);

function event(kind: number, dTag?: string): NostrEvent {
  return {
    id: NOTE,
    kind,
    pubkey: AUTHOR,
    created_at: 1,
    tags: dTag ? [['d', dTag]] : [],
    content: '',
    sig: '',
  } as NostrEvent;
}

describe('buildReactionTags', () => {
  it('default branch: e + p, no k (plain note target)', () => {
    expect(buildReactionTags(NOTE, AUTHOR, event(1))).toEqual([
      ['e', NOTE],
      ['p', AUTHOR],
    ]);
  });

  it('legacy branch without targetEvent: e = noteId + p', () => {
    expect(buildReactionTags(NOTE, AUTHOR)).toEqual([
      ['e', NOTE],
      ['p', AUTHOR],
    ]);
  });

  it('addressable target (30023): e = hex id + a = coordinate + k + p', () => {
    const tags = buildReactionTags(
      '30023:x:y',
      AUTHOR,
      event(30023, 'my-article')
    );
    expect(tags).toEqual([
      ['e', NOTE],
      ['a', `30023:${AUTHOR}:my-article`],
      ['k', '30023'],
      ['p', AUTHOR],
    ]);
  });

  it('reaction-on-reaction (kind 7 → 7): e + k:7 + p', () => {
    const parent = event(7);
    expect(buildReactionTags(parent.id!, '9'.repeat(64), parent)).toEqual([
      ['e', NOTE],
      ['k', '7'],
      ['p', '9'.repeat(64)],
    ]);
  });

  it('reaction-on-zap (kind 9735): e = receipt id + k:9735 + p = zap sender', () => {
    const receipt = event(9735);
    expect(buildReactionTags(receipt.id!, SENDER, receipt)).toEqual([
      ['e', NOTE],
      ['k', '9735'],
      ['p', SENDER],
    ]);
  });

  it('receipt without id falls through to the default branch', () => {
    const receipt = { kind: 9735, id: undefined } as unknown as NostrEvent;
    expect(buildReactionTags(NOTE, SENDER, receipt)).toEqual([
      ['e', NOTE],
      ['p', SENDER],
    ]);
  });
});
