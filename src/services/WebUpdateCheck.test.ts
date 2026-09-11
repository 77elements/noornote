import { describe, expect, it, vi } from 'vitest';

// Heavy import chains (DiagnosticLogger → lists → SystemLogger → DOM) mocked per the
// standard node-env testing pattern (see DMStore.test.ts).
vi.mock('./DiagnosticLogger', () => ({ diagLog: vi.fn() }));
vi.mock('./PlatformService', () => ({
  PlatformService: {
    getInstance: () => ({
      isBrowser: true,
      isElectron: false,
      isCapacitor: false,
    }),
  },
}));

import { shouldShowUpdateBanner } from './WebUpdateCheck';

describe('shouldShowUpdateBanner', () => {
  it('shows when the live deployed id differs from the running bundle id', () => {
    expect(shouldShowUpdateBanner('abc123', 'xyz789')).toBe(true);
  });

  it('stays quiet when the running bundle IS the deployed build (after reload)', () => {
    expect(shouldShowUpdateBanner('abc123', 'abc123')).toBe(false);
  });

  it('stays quiet when no live id could be fetched (offline / 404 / malformed)', () => {
    expect(shouldShowUpdateBanner('abc123', null)).toBe(false);
  });
});
