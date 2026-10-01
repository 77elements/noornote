/**
 * Wiring tests: web-comment (kind 1111 `#k: web`) filter scope in the
 * FeedOrchestrator's pollOnce catch-up path.
 *
 * Regression: the ProfileView new-posts poll queried the viewer's OWN web
 * comments (includeSelf defaulted to true), so an old self comment postdating
 * the profile's newest post surfaced as a bogus "new post from me" refresh
 * hint and was prepended into the foreign timeline. The includeOwnWebComments
 * flag must land in the ACTUAL relay filters, not just in the helper.
 *
 * Pattern: Object.create instance with all heavy deps injected/mocked
 * (no singleton, no transport/NDK, no IDB) — mirrors
 * OutboundRelaysOrchestrator.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SELF = 'f'.repeat(64);
const AUTHOR = 'a'.repeat(64);
const RELAY = 'wss://relay.test';

const { transportFetch } = vi.hoisted(() => ({
  transportFetch: vi.fn(() => [] as unknown[]),
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
    getInstance: () => ({ getCurrentUser: () => ({ pubkey: SELF }) }),
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

/** The authors array of the web-comment filter (2nd filter) in the last fetch. */
interface CapturedFilter {
  kinds?: number[];
  authors?: string[];
}

function lastWebCommentFilterAuthors(): string[] | undefined {
  const calls = transportFetch.mock.calls as unknown as [
    string[],
    CapturedFilter[],
  ][];
  const filters = calls[calls.length - 1]?.[1];
  return filters?.find(f => f.kinds?.includes(1111))?.authors;
}

beforeEach(() => {
  transportFetch.mockClear();
  transportFetch.mockImplementation(() => []);
});

describe('FeedOrchestrator pollOnce web-comment scope wiring', () => {
  it('excludes the viewer in author-scoped feeds (includeOwnWebComments=false)', async () => {
    const orch = makeOrchestrator();
    const now = Math.floor(Date.now() / 1000);
    await orch.pollOnce(
      [AUTHOR],
      now - 60,
      true,
      RELAY,
      undefined,
      true,
      false
    );
    expect(lastWebCommentFilterAuthors()).toEqual([AUTHOR]);
  });

  it('includes the viewer in the following feed (includeOwnWebComments=true)', async () => {
    const orch = makeOrchestrator();
    const now = Math.floor(Date.now() / 1000);
    await orch.pollOnce([AUTHOR], now - 60, true, RELAY, undefined, true, true);
    expect(lastWebCommentFilterAuthors()).toEqual([AUTHOR, SELF]);
  });

  it('defaults to include (legacy callers without the flag)', async () => {
    const orch = makeOrchestrator();
    const now = Math.floor(Date.now() / 1000);
    await orch.pollOnce([AUTHOR], now - 60, true, RELAY, undefined, true);
    expect(lastWebCommentFilterAuthors()).toEqual([AUTHOR, SELF]);
  });
});
