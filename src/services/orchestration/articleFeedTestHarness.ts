/**
 * Shared mock modules for the ArticleFeedOrchestrator test files.
 * Mirrors the feedOrchestratorTestHarness pattern: test files call these
 * factories inside their hoisted `vi.mock(...)` blocks so the heavy
 * collaborators (transport, lists, logger chain, base orchestrator) are
 * stubbed in ONE place instead of duplicated per test file.
 */
import { vi, type Mock } from 'vitest';

/** Shared spy — tests assert against this (hoisting-safe: vi.mock factories
 *  run lazily, after this module is initialized). */
export const mockFetchEvents: Mock = vi.fn();

export function relaysModule(): { fetchEvents: Mock } {
  return { fetchEvents: mockFetchEvents };
}

export function followsModule() {
  return { getAllFollowedPubkeys: vi.fn(() => []) };
}

export function lruCacheModule() {
  return {
    LRUCache: class {
      get() {
        return undefined;
      }
      set() {
        /* noop */
      }
      clear() {
        /* noop */
      }
      get size() {
        return 0;
      }
    },
    getCacheSize: () => 10,
  };
}

export function systemLoggerModule(): {
  SystemLogger: { getInstance: () => Record<string, ReturnType<typeof vi.fn>> };
} {
  return {
    SystemLogger: {
      getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
  };
}

export function longFormModule() {
  return {
    LongFormOrchestrator: { extractArticleMetadata: vi.fn(() => ({})) },
  };
}

export function orchestratorBaseModule() {
  return {
    Orchestrator: class {
      constructor(_name: string) {
        /* stubbed base — no router/transport in tests */
      }
      destroy() {
        /* noop */
      }
    },
  };
}
