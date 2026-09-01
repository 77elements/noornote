// @vitest-environment jsdom
/**
 * Tests for mergeInteractionEvents — classification (kind 7 / 9735 / 6 with
 * q-tag vs plain repost) and dedup by event id.
 */

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import {
  calculateTotalZapSats,
  mergeInteractionEvents,
  type InteractionEventBuckets,
} from './interactionMerge';

const HEX_NOTE = 'a'.repeat(64);

function ev(
  id: string,
  kind: number,
  tags: string[][] = [],
  content = ''
): NostrEvent {
  return {
    id,
    pubkey: 'b'.repeat(64),
    created_at: 1786701173,
    kind,
    tags,
    content,
    sig: 'c'.repeat(128),
  } as NostrEvent;
}

function emptyBuckets(): InteractionEventBuckets {
  return {
    reactionEvents: [],
    zapEvents: [],
    repostEvents: [],
    quotedEvents: [],
  };
}

describe('mergeInteractionEvents', () => {
  it('classifies reactions, zaps, reposts and quotes', () => {
    const cached = emptyBuckets();
    mergeInteractionEvents(
      cached,
      [
        ev('r1', 7, [['e', HEX_NOTE]], '+'),
        ev('z1', 9735, [['e', HEX_NOTE]]),
        ev('p1', 6, [['e', HEX_NOTE]]),
        ev('q1', 6, [['q', HEX_NOTE]], 'check this'),
      ],
      HEX_NOTE
    );
    expect(cached.reactionEvents.map(e => e.id)).toEqual(['r1']);
    expect(cached.zapEvents.map(e => e.id)).toEqual(['z1']);
    expect(cached.repostEvents.map(e => e.id)).toEqual(['p1']);
    expect(cached.quotedEvents.map(e => e.id)).toEqual(['q1']);
  });

  it('routes kind 6 with an a-tag on an addressable note to quotes', () => {
    const coord = `30054:${'b'.repeat(64)}:episode-1`;
    const cached = emptyBuckets();
    mergeInteractionEvents(
      cached,
      [ev('q1', 6, [['a', coord]], 'quoting')],
      coord
    );
    expect(cached.quotedEvents.map(e => e.id)).toEqual(['q1']);
    expect(cached.repostEvents.length).toBe(0);
  });

  it('dedups by event id across merges', () => {
    const cached = emptyBuckets();
    const reaction = ev('r1', 7, [['e', HEX_NOTE]], '+');
    mergeInteractionEvents(cached, [reaction], HEX_NOTE);
    mergeInteractionEvents(
      cached,
      [reaction, ev('r2', 7, [['e', HEX_NOTE]], '+')],
      HEX_NOTE
    );
    expect(cached.reactionEvents.length).toBe(2);
  });

  it('ignores unrelated kinds', () => {
    const cached = emptyBuckets();
    mergeInteractionEvents(
      cached,
      [ev('x1', 1, [['e', HEX_NOTE]], 'hi')],
      HEX_NOTE
    );
    expect(
      cached.reactionEvents.length +
        cached.zapEvents.length +
        cached.repostEvents.length +
        cached.quotedEvents.length
    ).toBe(0);
  });

  it('skips events without an id', () => {
    const cached = emptyBuckets();
    mergeInteractionEvents(
      cached,
      [ev('', 7, [['e', HEX_NOTE]], '+')],
      HEX_NOTE
    );
    expect(cached.reactionEvents.length).toBe(0);
  });
});

describe('calculateTotalZapSats', () => {
  it('dedupes zapper retries: two receipts with the same bolt11 count once', () => {
    const bolt11 = 'lnbc50m1testinvoice';
    const total = calculateTotalZapSats([
      ev('r1', 9735, [['bolt11', bolt11]]),
      ev('r2', 9735, [['bolt11', bolt11]]), // zapper retry — different id, same payment
    ]);
    expect(total).toBe(5_000_000); // lnbc50m = 50 mBTC — counted ONCE
  });

  it('different invoices sum up', () => {
    const total = calculateTotalZapSats([
      ev('r1', 9735, [['bolt11', 'lnbc50m1a']]),
      ev('r2', 9735, [['bolt11', 'lnbc21m1b']]),
    ]);
    expect(total).toBe(5_000_000 + 2_100_000);
  });

  it('receipts without a bolt11 tag contribute nothing', () => {
    const total = calculateTotalZapSats([
      ev('r1', 9735, [['p', 'a'.repeat(64)]]),
      ev('r2', 9735, [['bolt11', 'lnbc50m1a']]),
    ]);
    expect(total).toBe(5_000_000);
  });

  it('empty list → 0', () => {
    expect(calculateTotalZapSats([])).toBe(0);
  });
});
