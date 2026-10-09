/**
 * Shared vi.mock payloads for the ReactionsOrchestrator tests
 * (liveStats / stateBatch). Test-only — never imported by app code.
 */

import { vi } from 'vitest';

export const systemLoggerMock = {
  SystemLogger: {
    getInstance: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
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
