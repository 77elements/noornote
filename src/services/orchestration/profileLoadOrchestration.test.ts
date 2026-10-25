/* eslint-disable camelcase -- Nostr protocol event fields are snake_case by spec */
/**
 * PV orchestration regression tests (mocked) — the fast, mocked twin of
 * profileLoadLive.test.ts (manual live variant).
 *
 * Regression 1.9.2→1.9.3: the "fast empty profile" optimization concluded
 * "definitively empty" as soon as ONE responsive relay answered EOSE-empty,
 * retired every relay and showed the TV empty state ("No events found / Follow
 * some users…") on profiles full of posts. Root shape: an author's relay set
 * contains an auth-wall/stale-outbox relay that answers INSTANTLY empty while
 * the content relays are still connecting — the old quorum early-exit saw
 * "empty proof" and cut the fetch.
 *
 * The contract after the fix:
 * 1. A round that returns zero events must NOT globally retire pending relays.
 * 2. Only relays that individually answered eosed+empty retire per round.
 * 3. hasMore stays true while content relays are still in play.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as harness from './feedOrchestratorTestHarness';

const AUTHOR = 'a'.repeat(64);
const OUTBOX = 'wss://outbox.example';
const CONTENT = 'wss://content.example';

vi.mock('../transport/NostrTransport', () => harness.transportModule());
vi.mock('../AuthService', () => harness.authServiceModule());
vi.mock('../SystemLogger', () => harness.systemLoggerModule());
vi.mock('../DiagnosticLogger', () => harness.diagnosticLoggerModule());

import { FeedOrchestrator } from './FeedOrchestrator';
import { makeOrchestrator } from './feedOrchestratorTestHarness';
import { profileTimelineConfig } from '../../components/timeline/TimelineConfig';

const transportFetch = harness.feedTestState.transportFetch;

interface RelayOutcome {
  url: string;
  state: 'pending' | 'eosed' | 'error';
  count: number;
}

/** Build a NostrEvent-shaped object with the fields the pipeline touches. */
function makeNote(id: string, created_at: number) {
  return {
    id,
    pubkey: AUTHOR,
    kind: 1,
    created_at,
    content: `note ${id}`,
    tags: [] as string[][],
    sig: 'x'.repeat(128),
  };
}

/** Shape returned by fetchDirectPaged per relay. */
function perRelay(outcomes: RelayOutcome[]) {
  return Object.fromEntries(
    outcomes.map(e => [
      e.url,
      {
        oldest: null,
        count: e.count,
        eosed: e.state === 'eosed',
        state: e.state,
        ms: 0,
      },
    ])
  );
}

/**
 * Drive the PV path through its public entry (loadInitialFeed with a
 * profileTimelineConfig request → pagination 'until' + fetchMode 'direct').
 * The harness injects `transport.fetch`; loadProfileDirect calls
 * `transport.fetchDirectPaged(...)`, so the transport object is replaced with
 * a directFetchPaged-aliasing stub.
 */
function makePvOrchestrator(relayList: string[]) {
  const orch = makeOrchestrator(FeedOrchestrator) as unknown as {
    transport: unknown;
    muteOrchestrator: Record<string, unknown>;
    noteService: Record<string, unknown>;
    systemLogger: Record<string, unknown>;
    relayDiscovery: Record<string, unknown>;
    loadInitialFeed: FeedOrchestrator['loadInitialFeed'];
    // Object.create skips the constructor — fields it initializes must exist.
    mutedPubkeys: Set<string>;
    isManualPoll: boolean;
    profilePager: unknown;
  };
  orch.transport = { fetchDirectPaged: transportFetch };
  orch.relayDiscovery = {
    getProfileRelays: () => relayList,
    // getCombinedRelays is async and returns the relay list — with
    // includeOutbound=false it's just the standard read set.
    getCombinedRelays: async () => relayList,
  };
  orch.mutedPubkeys = new Set();
  orch.noteService = { registerNotes: vi.fn() };
  return orch;
}

describe('PV load orchestration (1.9.2 regression)', () => {
  beforeEach(() => {
    transportFetch.mockReset();
    harness.feedTestState.currentUser = AUTHOR;
  });

  it('keeps paging when one relay answers instant-empty and others are pending', async () => {
    // Round 1: OUTBOX answers instantly with EOSE+0 events, CONTENT pending.
    // Round 2: OUTBOX retired (never re-asked), CONTENT answers a full page.
    let round = 0;
    transportFetch.mockImplementation(async (relays: string[]) => {
      round++;
      if (round === 1) {
        expect(relays).toContain(OUTBOX);
        expect(relays).toContain(CONTENT);
        return {
          events: [],
          perRelay: perRelay([
            { url: OUTBOX, state: 'eosed', count: 0 },
            { url: CONTENT, state: 'pending', count: 0 },
          ]),
        };
      }
      // Round 2: only the content relay may be asked again (the eosed+empty
      // outbox relay retired itself in round 1).
      expect(relays).toEqual([CONTENT]);
      // Full page (pageSize 200) → relay NOT exhausted → hasMore stays true.
      const events = Array.from({ length: 200 }, (_, i) =>
        makeNote(`e${i}`, 2000 - i)
      );
      return {
        events,
        perRelay: perRelay([{ url: CONTENT, state: 'eosed', count: 200 }]),
      };
    });

    const orch = makePvOrchestrator([OUTBOX, CONTENT]);
    const result = await orch.loadInitialFeed({
      followingPubkeys: [AUTHOR],
      includeReplies: false,
      exemptFromMuteFilter: AUTHOR,
      config: profileTimelineConfig(AUTHOR),
    });

    // The 1.9.2 bug concluded empty here (events: [], hasMore: false).
    expect(result.events).toHaveLength(200);
    expect(result.hasMore).toBe(true);
    expect(transportFetch).toHaveBeenCalledTimes(2);
  });

  it('shows the empty state only after every relay individually drained', async () => {
    // Both relays answer eosed+empty — genuinely empty profile. Round 1
    // retires both, no second round, events empty, hasMore false. This is the
    // LEGITIMATE empty path (real 0-post profile).
    transportFetch.mockImplementation(async (relays: string[]) => ({
      events: [],
      perRelay: perRelay(
        relays.map(u => ({ url: u, state: 'eosed' as const, count: 0 }))
      ),
    }));

    const orch = makePvOrchestrator([OUTBOX, CONTENT]);
    const result = await orch.loadInitialFeed({
      followingPubkeys: [AUTHOR],
      includeReplies: false,
      exemptFromMuteFilter: AUTHOR,
      config: profileTimelineConfig(AUTHOR),
    });

    expect(result.events).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(transportFetch).toHaveBeenCalledTimes(1);
  });
});
