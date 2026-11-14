/**
 * Instant cache paint: loadInitialFeedFromCache serves the initial feed
 * from the LOCAL NDK cache (no network) so the timeline paints instantly on
 * open, with the relay fetch refreshing afterwards.
 *
 * Regression guard: cache-first AND direct-fetch views (PV) must get a
 * sorted, page-sized result built through the SAME filter construction and
 * processing as the network path; cold caches must return null so the
 * caller falls back to the network path unchanged.
 *
 * Pattern: Object.create instance with heavy deps injected/mocked — private
 * collaborators (processEvents/registerNotes) are replaced on the instance;
 * transport.fetchFromCache is the seam under test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as feedHarness from './feedOrchestratorTestHarness';

const { shouldFetchReactions } = vi.hoisted(() => ({
  shouldFetchReactions: vi.fn(() => true),
}));

vi.mock('../transport/NostrTransport', () => feedHarness.transportModule());
vi.mock('../AuthService', () => feedHarness.authServiceModule());
vi.mock('../SystemLogger', () => feedHarness.systemLoggerModule());
vi.mock('../DiagnosticLogger', () => feedHarness.diagnosticLoggerModule());
vi.mock('../../helpers/reactionsFeedSetting', () => ({
  shouldFetchReactions,
  isReactionShownFrom: () => true,
  getShowReactionsPubkeys: () => [],
}));

import { FeedOrchestrator } from './FeedOrchestrator';
import { makeOrchestrator } from './feedOrchestratorTestHarness';

function makeEvent(id: string, createdAt: number) {
  return {
    id,
    pubkey: 'a'.repeat(64),
    content: `note ${id.slice(0, 4)}`,
    tags: [] as string[][],
    kind: 1,
    created_at: createdAt,
    sig: 'x'.repeat(128),
  };
}

const TV_CONFIG = {
  source: { kind: 'following' } as const,
  relays: { kind: 'auto' } as const,
  range: { kind: 'live' } as const,
  includeReplies: false,
  fetchMode: 'cache-first' as const,
  pagination: 'window' as const,
  pageSize: 50,
  polling: true,
  trimDom: true,
  marketplaceInjection: false,
  applyWordFilter: true,
};

const PV_CONFIG = {
  ...TV_CONFIG,
  source: { kind: 'authors' } as const,
  relays: { kind: 'author-outbox' } as const,
  fetchMode: 'direct' as const,
  pagination: 'until' as const,
  pageSize: 200,
};

interface InjectableCacheOrchestrator {
  fetchLimit: number;
  transport: { fetchFromCache: ReturnType<typeof vi.fn> };
  processEvents: (events: unknown[]) => Promise<unknown[]>;
  registerNotes: (events: unknown[]) => void;
  loadInitialFeedFromCache: (request: unknown) => Promise<{
    events: unknown[];
    hasMore: boolean;
  } | null>;
}

function makeCacheOrchestrator(): InjectableCacheOrchestrator {
  const orch = makeOrchestrator(
    FeedOrchestrator as unknown as abstract new (...args: never[]) => object
  ) as unknown as InjectableCacheOrchestrator & Record<string, unknown>;

  orch.fetchLimit = 50;
  orch.transport.fetchFromCache = vi.fn().mockResolvedValue([]);
  orch.processEvents = vi.fn(async (events: unknown[]) => events);
  orch.registerNotes = vi.fn();
  return orch;
}

describe('FeedOrchestrator.loadInitialFeedFromCache — instant cache paint', () => {
  let orch: InjectableCacheOrchestrator;

  beforeEach(() => {
    orch = makeCacheOrchestrator();
    shouldFetchReactions.mockImplementation(() => true);
  });

  it('serves a sorted, page-sized result from the cache and registers the notes', async () => {
    const old1 = makeEvent('1'.repeat(64), 1_700_000_000);
    const old2 = makeEvent('2'.repeat(64), 1_699_900_000);
    const old3 = makeEvent('3'.repeat(64), 1_700_000_500);
    // Deliberately unsorted — the dexie adapter delivers per-author batches.
    orch.transport.fetchFromCache.mockResolvedValue([old1, old2, old3]);

    const result = await orch.loadInitialFeedFromCache({
      followingPubkeys: ['a'.repeat(64)],
      includeReplies: false,
      timeWindowHours: 1,
      config: TV_CONFIG,
    });

    expect(orch.transport.fetchFromCache).toHaveBeenCalledTimes(1);
    // Newest-first ordering despite the unsorted cache delivery.
    expect(result?.events).toEqual([old3, old1, old2]);
    expect(result?.hasMore).toBe(true);
    expect(orch.registerNotes).toHaveBeenCalledWith([old3, old1, old2]);
  });

  it('slices to pageSize after sorting', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      makeEvent(`${i + 1}`.padEnd(64, '0'), 1_700_000_000 - i * 60)
    );
    orch.transport.fetchFromCache.mockResolvedValue(many);
    const smallConfig = { ...TV_CONFIG, pageSize: 10 };

    const result = await orch.loadInitialFeedFromCache({
      followingPubkeys: ['a'.repeat(64)],
      includeReplies: false,
      timeWindowHours: 1,
      config: smallConfig,
    });

    expect(result?.events).toHaveLength(10);
    // The 10 NEWEST survive the slice.
    expect((result?.events[0] as { created_at: number }).created_at).toBe(
      1_700_000_000
    );
  });

  it('returns null on a cold cache (no cached events)', async () => {
    orch.transport.fetchFromCache.mockResolvedValue([]);

    const result = await orch.loadInitialFeedFromCache({
      followingPubkeys: ['a'.repeat(64)],
      includeReplies: false,
      timeWindowHours: 1,
      config: TV_CONFIG,
    });

    expect(result).toBeNull();
    expect(orch.registerNotes).not.toHaveBeenCalled();
  });

  it('returns null when everything is filtered out by processing', async () => {
    orch.transport.fetchFromCache.mockResolvedValue([
      makeEvent('1'.repeat(64), 1_700_000_000),
    ]);
    orch.processEvents = vi.fn().mockResolvedValue([]);

    const result = await orch.loadInitialFeedFromCache({
      followingPubkeys: ['a'.repeat(64)],
      includeReplies: false,
      timeWindowHours: 1,
      config: TV_CONFIG,
    });

    expect(result).toBeNull();
  });

  it('paints direct-fetch views (ProfileView) from cache too — gap-free network path unchanged', async () => {
    const note = makeEvent('1'.repeat(64), 1_700_000_000);
    orch.transport.fetchFromCache.mockResolvedValue([note]);

    const result = await orch.loadInitialFeedFromCache({
      followingPubkeys: ['a'.repeat(64)],
      includeReplies: false,
      config: PV_CONFIG,
    });

    expect(orch.transport.fetchFromCache).toHaveBeenCalledTimes(1);
    expect(result?.events).toEqual([note]);
    expect(result?.hasMore).toBe(true);
    expect(orch.registerNotes).toHaveBeenCalledWith([note]);

    // PV filters: until-pagination branch — authors + kinds + limit, and the
    // network path (loadProfileDirect) stays gap-free regardless of what the
    // cache painted (loadMore cursor = oldest state event, overlap → dedupe).
    const filters = (
      orch.transport.fetchFromCache.mock.calls[0] as unknown as [
        Array<Record<string, unknown>>,
      ]
    )[0];
    const main = filters.find(
      f => f.kinds && (f.kinds as number[]).includes(1)
    );
    expect(main?.since).toBeUndefined();
    expect(main?.until).toBeUndefined();
  });

  it('queries the cache WITHOUT a since bound (cache spans all ages)', async () => {
    orch.transport.fetchFromCache.mockResolvedValue([
      makeEvent('1'.repeat(64), 1_700_000_000),
    ]);

    await orch.loadInitialFeedFromCache({
      followingPubkeys: ['a'.repeat(64)],
      includeReplies: false,
      timeWindowHours: 1,
      config: TV_CONFIG,
    });

    const filters = (
      orch.transport.fetchFromCache.mock.calls[0] as unknown as [
        Array<Record<string, unknown>>,
      ]
    )[0];
    // The main feed filter must NOT carry the 1h window bound — the cache
    // query asks for the newest notes per author at any age.
    const main = filters.find(
      f => f.kinds && (f.kinds as number[]).includes(1)
    );
    expect(main).toBeDefined();
    expect(main?.since).toBeUndefined();
  });
});
