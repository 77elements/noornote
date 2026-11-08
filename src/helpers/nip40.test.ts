import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { getEventExpiration, isExpiredEvent } from './nip40';

// nip40.ts imports PerAccountLocalStorage, which drags in AuthService →
// UserHoverCard → lists/* (module-level StorageKeys access + circular init).
// Cut the chain — the tests below don't touch storage.
vi.mock('../services/PerAccountLocalStorage', () => {
  const StorageKeys = new Proxy(
    {},
    { get: (_t, prop: string) => `mock:${prop}` }
  );
  const getInstance = () => ({
    get: vi.fn((_key: unknown, def: unknown) => def),
    set: vi.fn(),
  });
  return {
    StorageKeys,
    PerAccountLocalStorage: { getInstance },
  };
});

function ev(tags: string[][]): NostrEvent {
  return { tags } as unknown as NostrEvent;
}

describe('getEventExpiration', () => {
  it('parses a valid expiration tag', () => {
    expect(getEventExpiration(ev([['expiration', '1750000000']]))).toBe(
      1750000000
    );
  });

  it('returns null when the tag is missing', () => {
    expect(getEventExpiration(ev([]))).toBeNull();
    expect(getEventExpiration(ev([['client', 'test']]))).toBeNull();
  });

  it('returns null for garbage values', () => {
    expect(getEventExpiration(ev([['expiration', 'abc']]))).toBeNull();
    expect(getEventExpiration(ev([['expiration', '']]))).toBeNull();
    expect(getEventExpiration(ev([['expiration', '-5']]))).toBeNull();
  });
});

describe('isExpiredEvent', () => {
  it('is true when the timestamp has passed', () => {
    expect(isExpiredEvent(ev([['expiration', '1000']]))).toBe(true);
  });

  it('is false when the timestamp is in the future', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(isExpiredEvent(ev([['expiration', String(future)]]))).toBe(false);
  });

  it('is false when there is no tag (valid-past rule)', () => {
    expect(isExpiredEvent(ev([]))).toBe(false);
  });
});
