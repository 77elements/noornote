import { describe, it, expect } from 'vitest';
import { isFoafEntryFresh, foafFollowCountTolerance, FOAF_CACHE_TTL_MS } from './foafFreshness';

const NOW = 1_700_000_000_000;

describe('foafFollowCountTolerance', () => {
  it('never goes below the 20-follow floor', () => {
    expect(foafFollowCountTolerance(10, 12)).toBe(20);
    expect(foafFollowCountTolerance(0, 0)).toBe(20);
  });

  it('scales with 5% of the larger count once that exceeds the floor', () => {
    expect(foafFollowCountTolerance(400, 400)).toBe(20); // 5% of 400 = 20 → floor
    expect(foafFollowCountTolerance(500, 500)).toBe(25);
    expect(foafFollowCountTolerance(500, 2000)).toBe(100); // measured against the LARGER
  });
});

describe('isFoafEntryFresh', () => {
  it('REGRESSION: AutoSync +1 follow after build must NOT invalidate the graph', () => {
    // The bug from 2026-08-22: strict === check discarded a fresh 28k-pubkey
    // graph (built at 418 follows) because the follow count had become 419.
    expect(isFoafEntryFresh(418, NOW - 60_000, 419, NOW)).toBe(true);
  });

  it('accepts small drift in both directions', () => {
    expect(isFoafEntryFresh(400, NOW - 3_600_000, 415, NOW)).toBe(true);
    expect(isFoafEntryFresh(415, NOW - 3_600_000, 400, NOW)).toBe(true);
  });

  it('rejects drift beyond the tolerance (graph is stale → rebuild)', () => {
    expect(isFoafEntryFresh(400, NOW - 3_600_000, 500, NOW)).toBe(false);
  });

  it('rejects entries older than the 24h TTL regardless of follow count', () => {
    expect(isFoafEntryFresh(400, NOW - FOAF_CACHE_TTL_MS, 400, NOW)).toBe(false);
    expect(isFoafEntryFresh(400, NOW - FOAF_CACHE_TTL_MS - 1, 400, NOW)).toBe(false);
    expect(isFoafEntryFresh(400, NOW - FOAF_CACHE_TTL_MS + 1, 400, NOW)).toBe(true);
  });

  it('future-built entries (clock skew) stay fresh within the TTL window', () => {
    expect(isFoafEntryFresh(400, NOW + 60_000, 400, NOW)).toBe(true);
  });
});
