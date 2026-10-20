/**
 * Shared vi.mock payloads for the ReactionsOrchestrator tests
 * (liveStats / stateBatch). Test-only — never imported by app code.
 */

import { vi, type Mock } from 'vitest';

// Explicit `Mock` annotations: vitest 5's inferred vi.fn() types reference an
// internal chunk file, which breaks declaration portability (TS2742/TS2883)
// under both TS 5.9 and TS 7.
export const systemLoggerMock = {
  SystemLogger: {
    getInstance: () => ({
      info: vi.fn() as Mock,
      warn: vi.fn() as Mock,
      error: vi.fn() as Mock,
    }),
  },
};

export const relayConfigMock = {
  RelayConfig: {
    getInstance: () => ({
      getReadRelays: () => ['wss://relay.test'],
      getAggregatorRelays: () => [],
      getWriteRelays: () => ['wss://relay.test'],
    }),
  },
};

export const userProfileMock = {
  UserProfileService: { getInstance: () => ({}) },
};

export const mutesMock = {
  isUserMuted: () => ({ public: false, private: false, any: false }),
};
