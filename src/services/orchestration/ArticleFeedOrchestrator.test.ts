import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFetchEvents } = vi.hoisted(() => ({ mockFetchEvents: vi.fn() }));

vi.mock('../../lists/relays', () => ({ fetchEvents: mockFetchEvents }));
vi.mock('../../lists/follows', () => ({ getAllFollowedPubkeys: vi.fn(() => []) }));
vi.mock('../../helpers/LRUCache', () => ({
  LRUCache: class { get() { return undefined; } set() { /* noop */ } clear() { /* noop */ } get size() { return 0; } },
  getCacheSize: () => 10,
}));
vi.mock('../SystemLogger', () => ({
  SystemLogger: {
    getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));
vi.mock('./LongFormOrchestrator', () => ({
  LongFormOrchestrator: { extractArticleMetadata: vi.fn(() => ({})) },
}));
vi.mock('./Orchestrator', () => ({
  Orchestrator: class {
    constructor(_name: string) { /* stubbed base — no router/transport in tests */ }
    destroy() { /* noop */ }
  },
}));

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { ArticleFeedOrchestrator, AUTHOR_FETCH_BATCH } from './ArticleFeedOrchestrator';

const mkArticle = (id: string, pubkey: string, dTag: string, createdAt: number, title = ''): NostrEvent =>
  ({ id, pubkey, kind: 30023, created_at: createdAt, tags: [['d', dTag], ['title', title]], content: '' } as NostrEvent);

const a1 = mkArticle('e1', 'aa', 'slug-a', 1000, 'A');
const a2 = mkArticle('e2', 'bb', 'slug-b', 2000, 'B');
const a3 = mkArticle('e3', 'cc', 'slug-c', 3000, 'C');

describe('ArticleFeedOrchestrator.fetchFollowingArticles (stateless pipeline)', () => {
  beforeEach(() => mockFetchEvents.mockReset());

  it('returns articles sorted desc with cursor = oldest created_at − 1', async () => {
    mockFetchEvents.mockResolvedValue([a1, a2, a3]);

    const res = await ArticleFeedOrchestrator.fetchFollowingArticles({
      authors: ['aa', 'bb', 'cc'], until: 10_000, limit: 20,
    });

    expect(res.articles.map(e => e.id)).toEqual(['e3', 'e2', 'e1']);
    expect(res.oldestTimestamp).toBe(999); // oldest (1000) − 1
  });

  it('dedupes by addressable id keeping the NEWEST version (replaceable updates)', async () => {
    const oldVersion = mkArticle('old', 'aa', 'slug-a', 1000);
    const newVersion = mkArticle('new', 'aa', 'slug-a', 5000, 'A v2');
    mockFetchEvents.mockResolvedValue([oldVersion, newVersion]);

    const res = await ArticleFeedOrchestrator.fetchFollowingArticles({
      authors: ['aa'], until: 10_000, limit: 20,
    });

    expect(res.articles).toHaveLength(1);
    expect(res.articles[0]!.id).toBe('new');
  });

  it('excludes caller-seen addressable ids (cross-page dedup)', async () => {
    mockFetchEvents.mockResolvedValue([a1, a2]);
    const seen = new Set(['aa:slug-a']); // a1 already rendered

    const res = await ArticleFeedOrchestrator.fetchFollowingArticles({
      authors: ['aa', 'bb'], until: 10_000, limit: 20, excludeIds: seen,
    });

    expect(res.articles.map(e => e.id)).toEqual(['e2']);
  });

  it('slices to the page limit; cursor follows the sliced oldest', async () => {
    mockFetchEvents.mockResolvedValue([a1, a2, a3]);

    const res = await ArticleFeedOrchestrator.fetchFollowingArticles({
      authors: ['aa', 'bb', 'cc'], until: 10_000, limit: 2,
    });

    expect(res.articles.map(e => e.id)).toEqual(['e3', 'e2']);
    expect(res.oldestTimestamp).toBe(1999); // page's oldest (2000) − 1
  });

  it('leaves the cursor UNCHANGED on an empty page (no infinite-jump contract)', async () => {
    mockFetchEvents.mockResolvedValue([]);
    const res = await ArticleFeedOrchestrator.fetchFollowingArticles({
      authors: ['aa'], until: 42, limit: 20,
    });
    expect(res.articles).toEqual([]);
    expect(res.oldestTimestamp).toBe(42);
  });

  it('batches authors by AUTHOR_FETCH_BATCH with one fetch per batch', async () => {
    mockFetchEvents.mockResolvedValue([]);
    const authors = Array.from({ length: AUTHOR_FETCH_BATCH * 2 + 10 }, (_, i) => `pk${i}`);

    await ArticleFeedOrchestrator.fetchFollowingArticles({ authors, until: 1, limit: 20 });

    expect(mockFetchEvents).toHaveBeenCalledTimes(3);
    const sizes = mockFetchEvents.mock.calls.map((c: unknown[]) => (c[0] as { authors: string[] }[])[0].authors.length);
    expect(sizes).toEqual([AUTHOR_FETCH_BATCH, AUTHOR_FETCH_BATCH, 10]);
  });

  it('a failed batch does not poison the page — remaining batches deliver', async () => {
    // 2 batches needed: 'aa' in batch 1 (fails), 'bb' in batch 2 (delivers a2)
    const authors = ['aa'];
    authors.push(...Array.from({ length: AUTHOR_FETCH_BATCH - 1 }, (_, i) => `pad1-${i}`));
    authors.push('bb');
    mockFetchEvents
      .mockRejectedValueOnce(new Error('relay hiccup'))
      .mockResolvedValueOnce([a2]);

    const res = await ArticleFeedOrchestrator.fetchFollowingArticles({
      authors, until: 10_000, limit: 20,
    });

    expect(res.articles.map(e => e.id)).toEqual(['e2']);
  });

  it('short-circuits on empty authors or non-positive limit (no relay traffic)', async () => {
    const res = await ArticleFeedOrchestrator.fetchFollowingArticles({ authors: [], until: 5, limit: 20 });
    expect(res.articles).toEqual([]);
    expect(res.oldestTimestamp).toBe(5);
    expect(mockFetchEvents).not.toHaveBeenCalled();
  });
});

describe('ArticleFeedOrchestrator.getAddressableId', () => {
  it('is pubkey + d-tag', () => {
    expect(ArticleFeedOrchestrator.getAddressableId(a1)).toBe('aa:slug-a');
  });
});
