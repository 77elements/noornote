/**
 * analyticsLogic — pure classification/merge tests (node env, no mocks).
 * Covers the classification decisions fixed with the user on 2026-08-27:
 * kind-1-only originals, 30023-only articles, strict engagement validation,
 * quotient semantics incl. the Infinity edge, and incremental merges.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyOwnContent,
  classifyInbox,
  classifySentZaps,
  computeZapsMetrics,
  extractOwnPosts,
  mergeCounts,
  mergeOwnContent,
  mergeTopPosts,
  compareTopPosts,
  subtractIds,
  tallyInboxByTarget,
  type LogicEvent,
  type TopPostEntry,
} from './analyticsLogic';

const OWN = 'own-1';
const OTHER = 'other-1';

function ev(
  partial: Partial<LogicEvent> & Pick<LogicEvent, 'kind'>
): LogicEvent {
  return {
    id: Math.random().toString(36).slice(2),
    created_at: 1_000,
    tags: [],
    ...partial,
  };
}

describe('classifyOwnContent', () => {
  it('classifies kind 1 by e-tag presence: original vs reply', () => {
    const { posts } = classifyOwnContent([
      ev({ kind: 1, id: 'a', tags: [] }),
      ev({ kind: 1, id: 'b', tags: [['e', 'xyz']] }),
      ev({ kind: 1, id: 'c', tags: [['p', 'someone']] }), // pure mention = original
    ]);
    expect(posts.originals).toBe(2);
    expect(posts.repliesKind1).toBe(1);
    expect(posts.comments1111).toBe(0);
    expect(posts.repliesTotal).toBe(1);
    expect(posts.quotient).toBeCloseTo(0.5);
  });

  it('counts kind 1111 comments separately and in the sum', () => {
    const { posts } = classifyOwnContent([
      ev({ kind: 1111, id: 'c1' }),
      ev({ kind: 1111, id: 'c2' }),
      ev({ kind: 1, id: 'r1', tags: [['e', 'x']] }),
    ]);
    expect(posts.comments1111).toBe(2);
    expect(posts.repliesKind1).toBe(1);
    expect(posts.repliesTotal).toBe(3);
    expect(posts.quotient).toBe(Number.POSITIVE_INFINITY);
  });

  it('counts content kinds: articles (30023 only), videos (21+22), listings', () => {
    const { content } = classifyOwnContent([
      ev({ kind: 30023, id: 'a1' }),
      ev({ kind: 30024, id: 'draft' }), // draft — must NOT count
      ev({ kind: 21, id: 'v1' }),
      ev({ kind: 22, id: 'v2' }),
      ev({ kind: 30402, id: 'l1' }),
    ]);
    expect(content.articles).toBe(1);
    expect(content.videos).toBe(2);
    expect(content.listings).toBe(1);
  });

  it('subtracts kind-5 deletions from counts and own ids', () => {
    const result = classifyOwnContent([
      ev({ kind: 1, id: 'keep1', tags: [] }),
      ev({ kind: 1, id: 'kill1', tags: [] }),
      ev({ kind: 30023, id: 'killA' }),
      ev({
        kind: 5,
        id: 'd1',
        tags: [
          ['e', 'kill1'],
          ['e', 'killA'],
        ],
      }),
    ]);
    expect(result.posts.originals).toBe(1);
    expect(result.content.articles).toBe(0);
    expect(result.ownEventIds.has('keep1')).toBe(true);
    expect(result.ownEventIds.has('kill1')).toBe(false);
    expect(result.deletedIds.has('kill1')).toBe(true);
  });

  it('tracks maxCreatedAt as since-cursor basis', () => {
    const { maxCreatedAt } = classifyOwnContent([
      ev({ kind: 1, created_at: 100 }),
      ev({ kind: 1, created_at: 900 }),
      ev({ kind: 5, created_at: 500 }),
    ]);
    expect(maxCreatedAt).toBe(900);
  });
});

describe('classifyInbox (strict validation)', () => {
  it('counts replies only when the e-tag targets an own event', () => {
    const ownIds = new Set([OWN]);
    const { engagement } = classifyInbox(
      [
        ev({ kind: 1, tags: [['e', OWN]] }),
        ev({ kind: 1, tags: [['e', OTHER]] }), // reply in someone else's thread → no
        ev({ kind: 1, tags: [['p', 'me']] }), // mention without e → no
        ev({ kind: 1111, tags: [['e', OWN]] }),
      ],
      ownIds
    );
    expect(engagement.repliesReceived).toBe(2);
  });

  it('separates reposts (e) from quoted reposts (q), strictly validated', () => {
    const ownIds = new Set([OWN]);
    const { engagement } = classifyInbox(
      [
        ev({
          kind: 6,
          tags: [
            ['e', OWN],
            ['p', 'me'],
          ],
        }),
        ev({
          kind: 6,
          tags: [
            ['e', OTHER],
            ['p', 'me'],
          ],
        }),
        ev({ kind: 6, tags: [['q', OWN]] }),
        ev({ kind: 6, tags: [['q', OTHER]] }),
      ],
      ownIds
    );
    expect(engagement.repostsReceived).toBe(1);
    expect(engagement.quotesReceived).toBe(1);
  });

  it('counts zap receipts with their bolt11 amounts', () => {
    // lnbc10u… = 10 × 100 sats (u multiplier) = 1,000 sats
    const { zapsReceived } = classifyInbox(
      [
        ev({
          kind: 9735,
          tags: [
            ['bolt11', 'lnbc10u1xyz'],
            ['p', 'me'],
          ],
        }),
      ],
      new Set()
    );
    expect(zapsReceived.count).toBe(1);
    expect(zapsReceived.sats).toBe(1_000);
  });
});

describe('zaps metrics', () => {
  it('computes the sent:received ratio from sums only', () => {
    const m = computeZapsMetrics(
      { count: 2, sats: 1_000 },
      { count: 5, sats: 4_000 }
    );
    expect(m.satsRatio).toBe(0.25);
    expect(m.sentSats).toBe(1_000);
    expect(m.receivedSats).toBe(4_000);
  });

  it('ratio is 0 when nothing was received', () => {
    const m = computeZapsMetrics({ count: 1, sats: 5 }, { count: 0, sats: 0 });
    expect(m.satsRatio).toBe(0);
  });
});

describe('classifySentZaps', () => {
  it('counts events and sums amounts', () => {
    const result = classifySentZaps([
      ev({ kind: 9735, created_at: 10, tags: [['bolt11', 'lnbc1u1a']] }), // 100 sats
      ev({ kind: 9735, created_at: 20, tags: [] }), // no bolt11 → 0
    ]);
    expect(result.count).toBe(2);
    expect(result.sats).toBe(100);
    expect(result.maxCreatedAt).toBe(20);
  });
});

describe('incremental merges (P6)', () => {
  it('mergeCounts adds per key', () => {
    expect(mergeCounts({ a: 1, b: 2 }, { a: 3, b: 0 })).toEqual({ a: 4, b: 2 });
  });

  it('mergeOwnContent merges counts, recomputes quotient, unions ids', () => {
    const delta = classifyOwnContent([
      ev({ kind: 1, id: 'n1', created_at: 2_000 }),
    ]);
    const merged = mergeOwnContent(
      {
        posts: {
          originals: 4,
          repliesKind1: 2,
          comments1111: 0,
          repliesTotal: 2,
          quotient: 2,
        },
        content: { articles: 1, videos: 0, listings: 0 },
        ownEventIds: ['old1', 'old2'],
      },
      delta
    );
    expect(merged.posts.originals).toBe(5);
    expect(merged.posts.repliesTotal).toBe(2);
    expect(merged.posts.quotient).toBeCloseTo(2 / 5);
    expect(merged.ownEventIds.has('old1')).toBe(true);
    expect(merged.ownEventIds.has('n1')).toBe(true);
  });

  it('mergeOwnContent removes prev ids targeted by delta deletions', () => {
    const delta = classifyOwnContent([
      ev({ kind: 5, id: 'd', tags: [['e', 'old1']] }),
    ]);
    const merged = mergeOwnContent(
      {
        posts: {
          originals: 2,
          repliesKind1: 0,
          comments1111: 0,
          repliesTotal: 0,
          quotient: 0,
        },
        content: { articles: 0, videos: 0, listings: 0 },
        ownEventIds: ['old1', 'old2'],
      },
      delta
    );
    expect(merged.ownEventIds.has('old1')).toBe(false);
    expect(merged.ownEventIds.has('old2')).toBe(true);
  });

  it('subtractIds filters', () => {
    expect(subtractIds(['a', 'b', 'c'], new Set(['b']))).toEqual(['a', 'c']);
  });
});

describe('top posts (P8)', () => {
  const mk = (o: Partial<TopPostEntry>): TopPostEntry => ({
    id: 'x',
    createdAt: 1,
    content: '',
    replies: 0,
    zaps: 0,
    zapSats: 0,
    reposts: 0,
    quotes: 0,
    likes: 0,
    ...o,
  });

  it('extractOwnPosts: kind-1 originals only, deletions excluded', () => {
    const { posts, deletedIds } = extractOwnPosts([
      ev({ kind: 1, id: 'p1', content: 'hello', tags: [] }),
      ev({ kind: 1, id: 'r', tags: [['e', 'x']] }), // reply → no
      ev({ kind: 1, id: 'gone', content: 'bye', tags: [] }),
      ev({ kind: 5, tags: [['e', 'gone']] }),
      ev({ kind: 1111, id: 'c1', content: 'comment', tags: [] }), // comment → no
    ]);
    expect(posts.map(p => p.id)).toEqual(['p1']);
    expect(posts[0].content).toBe('hello');
    expect(deletedIds.has('gone')).toBe(true);
  });

  it('tallyInboxByTarget maps kinds per e/q target, unattributable zaps skipped', () => {
    const tallies = tallyInboxByTarget([
      ev({ kind: 1, tags: [['e', 'p1']] }),
      ev({ kind: 1111, tags: [['e', 'p1']] }),
      ev({ kind: 6, tags: [['e', 'p1']] }),
      ev({ kind: 6, tags: [['q', 'p2']] }),
      ev({ kind: 7, tags: [['e', 'p1']] }),
      ev({ kind: 7, tags: [['e', 'p1']] }),
      ev({
        kind: 9735,
        tags: [
          ['e', 'p1'],
          ['bolt11', 'lnbc10u1xyz'],
        ],
      }),
      ev({ kind: 9735, tags: [['p', 'me']] }), // no e-tag → unattributed
    ]);
    expect(tallies.get('p1')).toEqual({
      replies: 2,
      zaps: 1,
      zapSats: 1_000,
      reposts: 1,
      quotes: 0,
      likes: 2,
    });
    expect(tallies.get('p2')?.quotes).toBe(1);
  });

  it('compareTopPosts: replies > zaps > reposts+quotes > likes > createdAt', () => {
    expect(compareTopPosts(mk({ replies: 1 }), mk({ zaps: 100 }))).toBeLessThan(
      0
    );
    expect(compareTopPosts(mk({ zaps: 1 }), mk({ reposts: 50 }))).toBeLessThan(
      0
    );
    expect(
      compareTopPosts(
        mk({ reposts: 5, quotes: 1 }),
        mk({ reposts: 4, quotes: 1 })
      )
    ).toBeLessThan(0);
    expect(
      compareTopPosts(
        mk({ likes: 2, createdAt: 5 }),
        mk({ likes: 2, createdAt: 9 })
      )
    ).toBeGreaterThan(0);
  });

  it('mergeTopPosts: additive delta on prev entries, drops deletions, ranks', () => {
    const prev: TopPostEntry[] = [
      mk({ id: 'p1', createdAt: 10, content: 'one', replies: 5 }),
      mk({ id: 'p2', createdAt: 20, content: 'two', zaps: 9, zapSats: 900 }),
    ];
    const tallies = new Map([
      [
        'p2',
        { replies: 1, zaps: 0, zapSats: 0, reposts: 0, quotes: 0, likes: 3 },
      ],
    ]);
    const merged = mergeTopPosts(
      prev,
      [{ id: 'p3', createdAt: 30, content: 'three' }],
      tallies,
      new Set(['p1'])
    );
    expect(merged.find(e => e.id === 'p1')).toBeUndefined();
    const p2 = merged.find(e => e.id === 'p2')!;
    expect(p2.replies).toBe(1);
    expect(p2.likes).toBe(3);
    expect(p2.zaps).toBe(9);
    expect(merged[0].id).toBe('p2'); // replies(1) > zeros
    expect(merged[1].id).toBe('p3');
  });

  it('mergeTopPosts caps at 20', () => {
    const prev = Array.from({ length: 25 }, (_, i) =>
      mk({ id: `p${i}`, createdAt: i, replies: i })
    );
    const merged = mergeTopPosts(prev, [], new Map(), new Set());
    expect(merged).toHaveLength(20);
    expect(merged[0].replies).toBe(24);
  });
});
