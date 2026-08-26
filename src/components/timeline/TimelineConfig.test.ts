import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockIsDataSaverEnabled } = vi.hoisted(() => ({
  mockIsDataSaverEnabled: vi.fn(() => false),
}));

vi.mock('../../services/DataSaverService', () => ({
  isDataSaverEnabled: mockIsDataSaverEnabled,
}));

vi.mock('../../services/PerAccountLocalStorage', () => {
  const store = new Map<string, unknown>();
  return {
    PerAccountLocalStorage: {
      getInstance: () => ({
        get: (key: string, def: unknown) =>
          store.has(key) ? store.get(key) : def,
        set: (key: string, v: unknown) => store.set(key, v),
      }),
    },
    StorageKeys: { TIMELINE_VIEW: 'timeline_view' },
  };
});

import {
  profileTimelineConfig,
  tribeTimelineConfig,
  followingTimelineConfig,
  relayFilterUrl,
  timeRangeOf,
  getSavedFeedMode,
  saveFeedMode,
} from './TimelineConfig';

const PK = 'ab'.repeat(32);

describe('buildTimelineConfig use-case matrix', () => {
  beforeEach(() => mockIsDataSaverEnabled.mockReturnValue(false));

  it('profile: single author, gap-free direct fetch, no trim, mute exempt', () => {
    const c = profileTimelineConfig(PK);
    expect(c.source).toEqual({ kind: 'authors', pubkeys: [PK] });
    expect(c.relays).toEqual({ kind: 'auto' });
    expect(c.fetchMode).toBe('direct');
    expect(c.pagination).toBe('until');
    expect(c.pageSize).toBe(200);
    expect(c.trimDom).toBe(false);
    expect(c.polling).toBe(true);
    expect(c.marketplaceInjection).toBe(false);
    expect(c.muteExemptPubkey).toBe(PK);
    expect(c.applyWordFilter).toBe(false);
    expect(c.includeReplies).toBe(false);
  });

  it('profile honors data-saver mode with smaller page', () => {
    mockIsDataSaverEnabled.mockReturnValue(true);
    expect(profileTimelineConfig(PK).pageSize).toBe(100);
  });

  it('tribe: explicit author set, window pagination, trimmed DOM', () => {
    const c = tribeTimelineConfig([PK, 'cd'.repeat(32)]);
    expect(c.source).toEqual({
      kind: 'authors',
      pubkeys: [PK, 'cd'.repeat(32)],
    });
    expect(c.fetchMode).toBe('cache-first');
    expect(c.pagination).toBe('window');
    expect(c.pageSize).toBe(50);
    expect(c.trimDom).toBe(true);
    expect(c.applyWordFilter).toBe(true);
    expect(c.muteExemptPubkey).toBeUndefined();
    expect(c.curatedFallbackWhenEmpty).toBeUndefined();
  });

  it('following: user follow list, marketplace injection + curated fallback', () => {
    const c = followingTimelineConfig();
    expect(c.source).toEqual({ kind: 'following' });
    expect(c.marketplaceInjection).toBe(true);
    expect(c.curatedFallbackWhenEmpty).toBe(true);
    expect(c.trimDom).toBe(true);
    expect(c.pagination).toBe('window');
  });

  it('following with no saved mode defaults to latest (replies off)', () => {
    expect(followingTimelineConfig().includeReplies).toBe(false);
  });
});

describe('runtime override readers', () => {
  it('relayFilterUrl: only explicit relay sets produce a filter', () => {
    const base = followingTimelineConfig();
    expect(relayFilterUrl(base)).toBeNull();
    expect(
      relayFilterUrl({ ...base, relays: { kind: 'author-outbox' } })
    ).toBeNull();
    expect(
      relayFilterUrl({
        ...base,
        relays: { kind: 'explicit', urls: ['wss://r'] },
      })
    ).toBe('wss://r');
    expect(
      relayFilterUrl({ ...base, relays: { kind: 'explicit', urls: [] } })
    ).toBeNull();
  });

  it('timeRangeOf: only between-ranges produce a window', () => {
    const base = followingTimelineConfig();
    expect(timeRangeOf(base)).toBeNull();
    expect(
      timeRangeOf({ ...base, range: { kind: 'between', since: 1, until: 2 } })
    ).toEqual({ since: 1, until: 2 });
  });
});

describe('feed mode persistence', () => {
  it('saves and restores latest-replies; unknown values fall back to latest', () => {
    expect(getSavedFeedMode()).toBe('latest');
    saveFeedMode('latest-replies');
    expect(getSavedFeedMode()).toBe('latest-replies');
    saveFeedMode('garbage' as never);
    expect(getSavedFeedMode()).toBe('latest');
  });
});
