import { describe, it, expect, vi } from 'vitest';

// pins.ts pulls the lists/ stack (relays.ts singletons at import time) — cut
// the heavy imports off and test only the pure tag-extraction helper.
vi.mock('./relays', () => ({
  fetchEvents: vi.fn(async () => []),
  getCurrentUserPubkey: vi.fn(() => null),
  publishEvent: vi.fn(async () => new Set<string>()),
  requireAuth: vi.fn(() => ({ pubkey: 'a'.repeat(64) })),
  signEvent: vi.fn(async () => null),
}));
vi.mock('../services/EventBus', () => ({
  EventBus: { getInstance: vi.fn(() => ({ on: vi.fn(() => 'sub') })) },
}));
vi.mock('../core/TypedEventBus', () => ({
  TypedEventBus: { getInstance: vi.fn(() => ({ emit: vi.fn() })) },
}));
vi.mock('../services/SystemLogger', () => ({
  SystemLogger: {
    getInstance: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
    })),
  },
}));
vi.mock('./storage', () => ({ now: vi.fn(() => 1000) }));

import { getPinnedEventId } from './pins';

describe('getPinnedEventId', () => {
  it('extracts the first e-tag id', () => {
    expect(
      getPinnedEventId({
        tags: [
          ['e', 'abc123'],
          ['client', 'test'],
        ],
      })
    ).toBe('abc123');
  });

  it('returns null for an empty pin list (unpinned)', () => {
    expect(getPinnedEventId({ tags: [] })).toBeNull();
  });

  it('ignores empty e-tags', () => {
    expect(
      getPinnedEventId({
        tags: [
          ['e', ''],
          ['e', 'xyz'],
        ],
      })
    ).toBe('xyz');
  });
});
