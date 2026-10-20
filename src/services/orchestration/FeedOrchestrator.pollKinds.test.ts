/**
 * Wiring tests: the show-reactions fetch gate in the polling paths.
 *
 * Regression: poll() and pollOnce() hardcoded `'following'` as the source
 * kind, so a ProfileView (source kind `authors`) polling its author fetched
 * kind-7 reactions whenever the show-reactions setting was on — followed
 * users' reactions surfaced as feed entries in the profile timeline. The
 * view's source kind must reach the actual relay filters, same wiring rule
 * as the web-comment scope tests (FeedOrchestrator.webCommentScope.test.ts).
 *
 * Pattern: Object.create instance with all heavy deps injected/mocked
 * (no singleton, no transport/NDK, no IDB).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const AUTHOR = 'a'.repeat(64);
const RELAY = 'wss://relay.test';

const { transportFetch, shouldFetchReactions } = vi.hoisted(() => ({
  transportFetch: vi.fn(() => [] as unknown[]),
  shouldFetchReactions: vi.fn(() => true),
}));

vi.mock('../transport/NostrTransport', () => ({
  NostrTransport: {
    getInstance: () => ({
      fetch: transportFetch,
      getReadRelays: () => [RELAY],
    }),
  },
}));

vi.mock('../AuthService', () => ({
  AuthService: {
    getInstance: () => ({ getCurrentUser: () => ({ pubkey: AUTHOR }) }),
  },
}));

vi.mock('../SystemLogger', () => ({
  SystemLogger: {
    getInstance: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    }),
  },
}));

vi.mock('../DiagnosticLogger', () => ({
  diagLog: vi.fn(),
}));

vi.mock('../../helpers/reactionsFeedSetting', () => ({
  shouldFetchReactions,
  isReactionShownFrom: () => true,
  getShowReactionsPubkeys: () => [],
}));

import { FeedOrchestrator } from './FeedOrchestrator';

type MockFn = ReturnType<typeof vi.fn>;

interface InjectableOrchestrator extends FeedOrchestrator {
  transport: { fetch: MockFn };
  muteOrchestrator: Record<string, unknown>;
  noteService: Record<string, unknown>;
  systemLogger: Record<string, unknown>;
  relayDiscovery: Record<string, unknown>;
  pollLimit: number;
}

function makeOrchestrator(): InjectableOrchestrator {
  const orch = Object.create(
    FeedOrchestrator.prototype
  ) as InjectableOrchestrator;
  orch.transport = { fetch: transportFetch };
  orch.muteOrchestrator = {
    getMutedUsers: () => new Set<string>(),
    isMuted: () => ({ public: false, private: false }),
  };
  orch.noteService = {};
  orch.systemLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  };
  orch.relayDiscovery = { getProfileRelays: () => [RELAY] };
  orch.pollLimit = 50;
  return orch;
}

interface CapturedFilter {
  kinds?: number[];
  authors?: string[];
}

/** All captured filters across every fetch of the last pollOnce run. */
function allFilters(): CapturedFilter[] {
  const calls = transportFetch.mock.calls as unknown as [
    string[],
    CapturedFilter[],
  ][];
  return calls.flatMap(call => call[1]);
}

beforeEach(() => {
  transportFetch.mockClear();
  transportFetch.mockImplementation(() => []);
  shouldFetchReactions.mockImplementation(() => true);
});

describe('FeedOrchestrator pollOnce show-reactions scope wiring', () => {
  it('author-scoped view (PV): no kind-7 filter even with the setting on', async () => {
    const orch = makeOrchestrator();
    const now = Math.floor(Date.now() / 1000);
    await orch.pollOnce(
      [AUTHOR],
      now - 60,
      true,
      RELAY,
      undefined,
      true,
      false,
      'authors'
    );
    expect(allFilters().some(f => f.kinds?.includes(7))).toBe(false);
  });

  it('following feed (TV): kind-7 filter present with the setting on', async () => {
    const orch = makeOrchestrator();
    const now = Math.floor(Date.now() / 1000);
    await orch.pollOnce(
      [AUTHOR],
      now - 60,
      true,
      RELAY,
      undefined,
      true,
      true,
      'following'
    );
    expect(allFilters().some(f => f.kinds?.includes(7))).toBe(true);
  });

  it('legacy callers without a source kind get no kind-7 filter', async () => {
    const orch = makeOrchestrator();
    const now = Math.floor(Date.now() / 1000);
    await orch.pollOnce([AUTHOR], now - 60, true, RELAY, undefined, true);
    expect(allFilters().some(f => f.kinds?.includes(7))).toBe(false);
  });
});
