/**
 * Initial-load paint latency: the auto-expand loop in loadInitialFeed must
 * stop at the FIRST chunk that yields any event instead of blocking on
 * accumulating 10 notes through sequential relay round-trips.
 *
 * Regression: on sparse feeds the old minimumNotes=10 loop chained up to 16
 * loadMore round-trips BEFORE first paint — the dominant "app opens too
 * slowly" cost on mobile (each round-trip is a full relay RTT). The
 * InfiniteScroll sentinel fills the rest after paint.
 *
 * Pattern: Object.create instance with heavy deps mocked — private
 * collaborators (getRelaysForRequest/fetchEvents/processEvents/registerNotes)
 * are replaced on the instance; the real loadMore runs underneath.
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
import { feedTestState, makeOrchestrator } from './feedOrchestratorTestHarness';

const EV1 = {
  id: '1'.repeat(64),
  pubkey: 'a'.repeat(64),
  content: 'first',
  tags: [] as string[][],
  kind: 1,
  created_at: 1_700_000_000,
  sig: 'x'.repeat(128),
};
const EV2 = { ...EV1, id: '2'.repeat(64), created_at: 1_699_999_000 };

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

interface InjectableInitOrchestrator {
  fetchLimit: number;
  profileFetchLimit: number;
  getRelaysForRequest: (f: unknown) => Promise<string[]>;
  fetchEvents: (f: unknown) => Promise<unknown[]>;
  processEvents: (events: unknown[]) => Promise<unknown[]>;
  registerNotes: (events: unknown[]) => void;
  loadInitialFeed: (request: unknown) => Promise<{
    events: unknown[];
    hasMore: boolean;
  }>;
}

function makeInitOrchestrator(): InjectableInitOrchestrator {
  const orch = makeOrchestrator(
    FeedOrchestrator as unknown as abstract new (...args: never[]) => object
  ) as unknown as InjectableInitOrchestrator & Record<string, unknown>;

  // Object.create skips the constructor — the fetch-size fields must be set.
  orch.fetchLimit = 50;
  orch.profileFetchLimit = 200;

  orch.getRelaysForRequest = vi.fn().mockResolvedValue(['wss://relay.test']);
  orch.processEvents = vi.fn(async (events: unknown[]) => events);
  orch.registerNotes = vi.fn();
  return orch;
}

describe('FeedOrchestrator.loadInitialFeed — paint-first auto-expand', () => {
  let orch: InjectableInitOrchestrator;

  beforeEach(() => {
    orch = makeInitOrchestrator();
    feedTestState.currentUser = 'a'.repeat(64);
    feedTestState.transportFetch.mockClear();
    feedTestState.transportFetch.mockImplementation(() => []);
    shouldFetchReactions.mockImplementation(() => true);
  });

  it('paints immediately when the 1h window already has notes (no auto-expand)', async () => {
    orch.fetchEvents = vi.fn().mockResolvedValue([EV1, EV2]);

    const result = await orch.loadInitialFeed({
      followingPubkeys: ['a'.repeat(64)],
      includeReplies: false,
      timeWindowHours: 1,
      config: TV_CONFIG,
    });

    expect(orch.fetchEvents).toHaveBeenCalledTimes(1);
    expect(result.events).toEqual([EV1, EV2]);
    expect(result.hasMore).toBe(true);
  });

  it('breaks the auto-expand loop at the FIRST non-empty chunk (no wait for 10 notes)', async () => {
    orch.fetchEvents = vi
      .fn()
      .mockResolvedValueOnce([]) // 1h window: empty
      .mockResolvedValueOnce([EV1, EV2]); // first 3h chunk: 2 notes — enough

    const result = await orch.loadInitialFeed({
      followingPubkeys: ['a'.repeat(64)],
      includeReplies: false,
      timeWindowHours: 1,
      config: TV_CONFIG,
    });

    // Exactly ONE auto-expand round-trip — the old code would have kept
    // chaining loadMore calls until 10 notes were accumulated.
    expect(orch.fetchEvents).toHaveBeenCalledTimes(2);
    expect(result.events).toEqual([EV1, EV2]);
    expect(result.hasMore).toBe(true);
  });

  it('keeps searching (bounded) when 48h yield nothing at all', async () => {
    orch.fetchEvents = vi.fn().mockResolvedValue([]);

    const result = await orch.loadInitialFeed({
      followingPubkeys: ['a'.repeat(64)],
      includeReplies: false,
      timeWindowHours: 1,
      config: TV_CONFIG,
    });

    expect(result.events).toEqual([]);
    expect(result.hasMore).toBe(false);
  });
});
