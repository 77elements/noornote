/**
 * Shared test harness for FeedOrchestrator wiring tests (pollKinds,
 * webCommentScope). Mock modules are built here so each test file only keeps
 * thin `vi.mock` factories; the shared state object is read LAZILY by the
 * mock getters (the factories themselves must not touch it — they run during
 * module resolution, before the test file body).
 *
 * The harness deliberately has no runtime import of FeedOrchestrator (type
 * import only) — the test passes the class in, avoiding a mock-factory
 * circular import.
 */
import { vi } from 'vitest';
import type { FeedOrchestrator } from './FeedOrchestrator';

export const RELAY = 'wss://relay.test';

/** Mutable state the mock getters read lazily (set at test-file top level). */
export const feedTestState = {
  currentUser: '',
  transportFetch: vi.fn(() => [] as unknown[]),
};

export function transportModule(): Record<string, unknown> {
  return {
    NostrTransport: {
      getInstance: () => ({
        fetch: feedTestState.transportFetch,
        getReadRelays: () => [RELAY],
      }),
    },
  };
}

export function authServiceModule(): Record<string, unknown> {
  return {
    AuthService: {
      getInstance: () => ({
        getCurrentUser: () => ({ pubkey: feedTestState.currentUser }),
      }),
    },
  };
}

export function systemLoggerModule(): Record<string, unknown> {
  return {
    SystemLogger: {
      getInstance: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        success: vi.fn(),
      }),
    },
  };
}

export function diagnosticLoggerModule(): Record<string, unknown> {
  return { diagLog: vi.fn() };
}

type MockFn = ReturnType<typeof vi.fn>;

export interface InjectableOrchestrator {
  transport: { fetch: MockFn };
  muteOrchestrator: Record<string, unknown>;
  noteService: Record<string, unknown>;
  systemLogger: Record<string, unknown>;
  relayDiscovery: Record<string, unknown>;
  pollLimit: number;
  /** Public pollOnce signature (private members are excluded on purpose). */
  pollOnce: FeedOrchestrator['pollOnce'];
}

export function makeOrchestrator(
  FeedOrchestratorClass: abstract new (...args: never[]) => object
): InjectableOrchestrator {
  const orch = Object.create(
    (FeedOrchestratorClass as { prototype: object }).prototype
  ) as unknown as InjectableOrchestrator;
  orch.transport = { fetch: feedTestState.transportFetch };
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

export interface CapturedFilter {
  kinds?: number[];
  authors?: string[];
}

/** All captured filters across every fetch of the last pollOnce run. */
export function allFilters(): CapturedFilter[] {
  const calls = feedTestState.transportFetch.mock.calls as unknown as [
    string[],
    CapturedFilter[],
  ][];
  return calls.flatMap(call => call[1]);
}
