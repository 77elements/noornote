/**
 * Instant cache paint for the article feed: fetchArticlesFromCache
 * serves the newest cached kind:30023 articles from the LOCAL NDK cache
 * (no network) so the ArticleTimeline paints instantly on open.
 *
 * Regression guard: author batching must match the network path, replaceable
 * duplicates must collapse to the newest version per addressable id, output
 * must be sorted desc and sliced to the requested page size.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import * as harness from './articleFeedTestHarness';

const { mockFetchFromCache } = vi.hoisted(() => ({
  mockFetchFromCache: vi.fn(async () => [] as unknown[]),
}));

vi.mock('../transport/NostrTransport', () => ({
  NostrTransport: {
    getInstance: () => ({ fetchFromCache: mockFetchFromCache }),
  },
}));
vi.mock('../../lists/relays', () => harness.relaysModule());
vi.mock('../../lists/follows', () => harness.followsModule());
vi.mock('../../helpers/LRUCache', () => harness.lruCacheModule());
vi.mock('../SystemLogger', () => harness.systemLoggerModule());
vi.mock('./LongFormOrchestrator', () => harness.longFormModule());
vi.mock('./Orchestrator', () => harness.orchestratorBaseModule());

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import {
  ArticleFeedOrchestrator,
  AUTHOR_FETCH_BATCH,
} from './ArticleFeedOrchestrator';

const mkArticle = (
  id: string,
  pubkey: string,
  dTag: string,
  createdAt: number
): NostrEvent =>
  ({
    id,
    pubkey,
    content: `article ${dTag}`,
    tags: [
      ['d', dTag],
      ['title', `Article ${dTag}`],
    ],
    kind: 30023,
    created_at: createdAt,
    sig: 'x'.repeat(128),
  }) as unknown as NostrEvent;

describe('ArticleFeedOrchestrator.fetchArticlesFromCache — instant cache paint', () => {
  beforeEach(() => {
    mockFetchFromCache.mockClear();
    mockFetchFromCache.mockResolvedValue([]);
  });

  it('returns [] for empty authors or non-positive limit', async () => {
    expect(
      await ArticleFeedOrchestrator.fetchArticlesFromCache([], 20)
    ).toEqual([]);
    expect(
      await ArticleFeedOrchestrator.fetchArticlesFromCache(['a'.repeat(64)], 0)
    ).toEqual([]);
    expect(mockFetchFromCache).not.toHaveBeenCalled();
  });

  it('dedupes replaceable versions (newest per pubkey:d-tag) and sorts desc', async () => {
    const pk = 'a'.repeat(64);
    // Same addressable id twice — the cache query may see both across batches.
    const oldVersion = mkArticle('1'.repeat(64), pk, 'post', 1_700_000_000);
    const newVersion = mkArticle('2'.repeat(64), pk, 'post', 1_700_000_500);
    const other = mkArticle('3'.repeat(64), pk, 'other', 1_699_000_000);
    mockFetchFromCache.mockResolvedValue([oldVersion, other, newVersion]);

    const result = await ArticleFeedOrchestrator.fetchArticlesFromCache(
      [pk],
      20
    );

    expect(result).toEqual([newVersion, other]);
  });

  it('slices to the requested page size', async () => {
    const pk = 'a'.repeat(64);
    const many = Array.from({ length: 30 }, (_, i) =>
      mkArticle(`${i + 1}`.padEnd(64, '0'), pk, `d${i}`, 1_700_000_000 - i * 60)
    );
    mockFetchFromCache.mockResolvedValue(many);

    const result = await ArticleFeedOrchestrator.fetchArticlesFromCache(
      [pk],
      20
    );

    expect(result).toHaveLength(20);
    expect(result[0]!.created_at).toBe(1_700_000_000);
  });

  it('batches authors like the network path (one filter per AUTHOR_FETCH_BATCH)', async () => {
    const authors = Array.from({ length: AUTHOR_FETCH_BATCH + 10 }, (_, i) =>
      `${i}`.padStart(64, '0')
    );
    mockFetchFromCache.mockResolvedValue([]);

    await ArticleFeedOrchestrator.fetchArticlesFromCache(authors, 20);

    expect(mockFetchFromCache).toHaveBeenCalledTimes(1);
    const filters = (
      mockFetchFromCache.mock.calls[0] as unknown as [
        Array<{ authors: string[]; kinds: number[]; limit: number }>,
      ]
    )[0];
    expect(filters).toHaveLength(2);
    expect(filters[0]!.authors).toHaveLength(AUTHOR_FETCH_BATCH);
    expect(filters[1]!.authors).toHaveLength(10);
    expect(filters[0]!.kinds).toEqual([30023]);
  });
});
