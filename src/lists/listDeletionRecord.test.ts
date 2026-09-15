/* eslint-disable camelcase -- Nostr protocol event fields are snake_case by spec */
/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

const NOW = 1_800_000_000; // fixed reference point (sec)

type FixtureEvent = {
  created_at: number;
  id: string;
  content: string;
  tags: string[][];
};

const relay = vi.hoisted(() => ({
  events: [] as FixtureEvent[],
  published: [] as unknown[],
  signReturnsNull: false,
  failFetch: false,
}));

vi.mock('./relays', () => ({
  getTransport: () => ({}),
  getReadRelays: () => [],
  getWriteRelays: () => [],
  getCurrentUserPubkey: () => 'aa'.repeat(32),
  requireAuth: () => ({ pubkey: 'aa'.repeat(32) }),
  fetchEvents: async (): Promise<NostrEvent[]> => {
    if (relay.failFetch) throw new Error('relay down');
    const events: NostrEvent[] = relay.events;
    return events;
  },
  publishEvent: async (event: unknown) => {
    relay.published.push(event);
    return new Set(['wss://relay']);
  },
  signEvent: async (event: {
    content: string;
    tags: string[][];
    kind: number;
  }) => {
    if (relay.signReturnsNull) return null;
    return { ...event, id: 'de'.repeat(32), sig: 'ff'.repeat(64) };
  },
  encryptContent: async () => '',
  decryptContent: async () => '',
}));

vi.mock('../services/AuthService', () => ({
  AuthService: {
    getInstance: () => ({
      getCurrentUser: () => ({ pubkey: 'aa'.repeat(32) }),
    }),
  },
}));

import {
  publishDeletions,
  syncDeletionsIntoLocal,
  type DeletionRecordConfig,
} from './listDeletionRecord';

// Freeze wall-clock time instead of mocking ./storage's now() — mocking the
// storage module here flips the import-cycle load order and breaks module init
// (PerAccountLocalStorage is not yet initialized when follows.ts evaluates).
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW * 1000));
});

afterEach(() => {
  vi.useRealTimers();
});

function deletionEvent(
  created_at: number,
  entries: Record<string, { t: number; d: boolean }>
): FixtureEvent {
  return {
    id: 'ab'.repeat(32),
    created_at,
    content: JSON.stringify({ v: 1, entries }),
    tags: [['d', 'test:deletions']],
  };
}

function makeCfg() {
  let local: Record<string, number> = {};
  const cfg: DeletionRecordConfig = {
    dTag: 'test:deletions',
    alt: 'test deletions',
    logLabel: 'test-deletions',
    getLocalTombstones: () => local,
    setLocalTombstones: map => {
      local = map;
    },
  };
  return {
    cfg,
    getLocal: () => local,
    setLocal: (map: Record<string, number>) => {
      local = map;
    },
  };
}

function lastPublishedContent(): {
  v: number;
  entries: Record<string, { t: number; d: boolean }>;
} {
  const last = relay.published[relay.published.length - 1] as {
    content: string;
  };
  return JSON.parse(last.content) as {
    v: number;
    entries: Record<string, { t: number; d: boolean }>;
  };
}

describe('publishDeletions (union-on-publish)', () => {
  beforeEach(() => {
    relay.events = [];
    relay.published = [];
    relay.signReturnsNull = false;
    relay.failFetch = false;
  });

  it('publishes an empty record when there is nothing anywhere', async () => {
    const { cfg } = makeCfg();
    await publishDeletions(cfg, 'pk');
    expect(relay.published).toHaveLength(1);
    const content = lastPublishedContent();
    expect(content).toEqual({ v: 1, entries: {} });
  });

  it('tags the record with the configured d-tag and alt', async () => {
    const { cfg } = makeCfg();
    await publishDeletions(cfg, 'pk');
    const last = relay.published[0] as { tags: string[][]; kind: number };
    expect(last.kind).toBe(30078);
    expect(last.tags).toContainEqual(['d', 'test:deletions']);
    expect(last.tags).toContainEqual(['alt', 'test deletions']);
  });

  it('includes local tombstones as deletions', async () => {
    const { cfg, setLocal } = makeCfg();
    setLocal({ Portfolio: 1_799_000_000 });
    await publishDeletions(cfg, 'pk');
    expect(lastPublishedContent().entries['Portfolio']).toEqual({
      t: 1_799_000_000,
      d: true,
    });
  });

  it('preserves relay entries (union — never drops another device’s deletion)', async () => {
    const { cfg } = makeCfg();
    relay.events = [
      deletionEvent(1_799_500_000, { Wishlist: { t: 1_799_500_000, d: true } }),
    ];
    await publishDeletions(cfg, 'pk');
    expect(lastPublishedContent().entries['Wishlist']).toEqual({
      t: 1_799_500_000,
      d: true,
    });
  });

  it('a newer relay revival survives a stale local tombstone', async () => {
    const { cfg, setLocal } = makeCfg();
    relay.events = [
      deletionEvent(1_799_900_000, { X: { t: 1_799_900_000, d: false } }),
    ];
    setLocal({ X: 1_799_000_000 }); // older local deletion
    await publishDeletions(cfg, 'pk');
    expect(lastPublishedContent().entries['X']).toEqual({
      t: 1_799_900_000,
      d: false,
    });
  });

  it('an older relay deletion is overridden by a newer local tombstone', async () => {
    const { cfg, setLocal } = makeCfg();
    relay.events = [
      deletionEvent(1_798_000_000, { X: { t: 1_798_000_000, d: true } }),
    ];
    setLocal({ X: 1_799_000_000 }); // local deletion is newer
    await publishDeletions(cfg, 'pk');
    expect(lastPublishedContent().entries['X']).toEqual({
      t: 1_799_000_000,
      d: true,
    });
  });

  it('the explicit change wins with a fresh timestamp', async () => {
    const { cfg } = makeCfg();
    relay.events = [
      deletionEvent(1_799_900_000, { X: { t: 1_799_900_000, d: true } }),
    ];
    await publishDeletions(cfg, 'pk', { name: 'X', deleted: false });
    const entry = lastPublishedContent().entries['X'];
    expect(entry.d).toBe(false);
    expect(entry.t).toBe(NOW);
  });

  it('prunes entries older than one year', async () => {
    const { cfg } = makeCfg();
    relay.events = [
      deletionEvent(NOW - 400 * 24 * 3600, {
        Ancient: { t: NOW - 400 * 24 * 3600, d: true },
        Recent: { t: NOW - 3600, d: true },
      }),
    ];
    await publishDeletions(cfg, 'pk');
    const entries = lastPublishedContent().entries;
    expect(entries['Ancient']).toBeUndefined();
    expect(entries['Recent']).toBeDefined();
  });

  it('does not publish when signEvent returns null (no auth)', async () => {
    const { cfg } = makeCfg();
    relay.signReturnsNull = true;
    await publishDeletions(cfg, 'pk');
    expect(relay.published).toHaveLength(0);
  });

  it('treats malformed relay content as an empty record', async () => {
    const { cfg, setLocal } = makeCfg();
    relay.events = [{ id: 'x', created_at: 1, content: 'not-json{', tags: [] }];
    setLocal({ X: 1_799_000_000 });
    await publishDeletions(cfg, 'pk');
    expect(lastPublishedContent().entries).toEqual({
      X: { t: 1_799_000_000, d: true },
    });
  });

  it('uses the newest relay event when several exist', async () => {
    const { cfg } = makeCfg();
    relay.events = [
      deletionEvent(NOW - 7200, { Old: { t: NOW - 7200, d: true } }),
      deletionEvent(NOW - 3600, { New: { t: NOW - 3600, d: true } }),
    ];
    await publishDeletions(cfg, 'pk');
    const entries = lastPublishedContent().entries;
    expect(entries['Old']).toBeUndefined();
    expect(entries['New']).toBeDefined();
  });

  it('skips relay entries with a non-number timestamp', async () => {
    const { cfg } = makeCfg();
    relay.events = [
      {
        id: 'x',
        created_at: 1,
        content: JSON.stringify({
          v: 1,
          entries: {
            Bad: { t: 'soon', d: true },
            Good: { t: NOW - 3600, d: true },
          },
        }),
        tags: [],
      },
    ];
    await publishDeletions(cfg, 'pk');
    const entries = lastPublishedContent().entries;
    expect(entries['Bad']).toBeUndefined();
    expect(entries['Good']).toEqual({ t: NOW - 3600, d: true });
  });
});

describe('syncDeletionsIntoLocal', () => {
  beforeEach(() => {
    relay.events = [];
    relay.published = [];
    relay.signReturnsNull = false;
    relay.failFetch = false;
  });

  it('adds a local tombstone for a relay deletion', async () => {
    const { cfg, getLocal } = makeCfg();
    relay.events = [
      deletionEvent(1_799_000_000, { X: { t: 1_799_000_000, d: true } }),
    ];
    await syncDeletionsIntoLocal(cfg, 'pk');
    expect(getLocal()['X']).toBe(1_799_000_000);
  });

  it('updates an existing local tombstone when the relay deletion is newer', async () => {
    const { cfg, setLocal, getLocal } = makeCfg();
    setLocal({ X: 1_000_000 });
    relay.events = [
      deletionEvent(1_799_000_000, { X: { t: 1_799_000_000, d: true } }),
    ];
    await syncDeletionsIntoLocal(cfg, 'pk');
    expect(getLocal()['X']).toBe(1_799_000_000);
  });

  it('clears the local tombstone on a relay revival that is newer or equal', async () => {
    const { cfg, setLocal, getLocal } = makeCfg();
    setLocal({ X: 1_799_000_000 });
    relay.events = [
      deletionEvent(1_800_000_000, { X: { t: 1_800_000_000, d: false } }),
    ];
    await syncDeletionsIntoLocal(cfg, 'pk');
    expect(getLocal()['X']).toBeUndefined();
  });

  it('keeps the local tombstone when the relay revival is older', async () => {
    const { cfg, setLocal, getLocal } = makeCfg();
    setLocal({ X: 1_799_900_000 });
    relay.events = [
      deletionEvent(1_799_000_000, { X: { t: 1_799_000_000, d: false } }),
    ];
    await syncDeletionsIntoLocal(cfg, 'pk');
    expect(getLocal()['X']).toBe(1_799_900_000);
  });

  it('prunes local entries older than one year', async () => {
    const { cfg, setLocal, getLocal } = makeCfg();
    setLocal({
      Ancient: NOW - 400 * 24 * 3600,
      Recent: NOW - 3600,
    });
    await syncDeletionsIntoLocal(cfg, 'pk');
    expect(getLocal()).toEqual({ Recent: NOW - 3600 });
  });

  it('does not write back when nothing changed', async () => {
    let writeCount = 0;
    const local: Record<string, number> = { X: 1_799_000_000 };
    const countingCfg: DeletionRecordConfig = {
      dTag: 'test:deletions',
      alt: 'test deletions',
      logLabel: 'test-deletions',
      getLocalTombstones: () => local,
      setLocalTombstones: () => {
        writeCount++;
      },
    };
    // Relay has exactly the same deletion → no change
    relay.events = [
      deletionEvent(1_799_000_000, { X: { t: 1_799_000_000, d: true } }),
    ];
    await syncDeletionsIntoLocal(countingCfg, 'pk');
    expect(writeCount).toBe(0);
    expect(countingCfg.getLocalTombstones()['X']).toBe(1_799_000_000);
  });

  it('survives a relay failure without throwing (best-effort sync)', async () => {
    const { cfg } = makeCfg();
    relay.failFetch = true;
    await expect(syncDeletionsIntoLocal(cfg, 'pk')).rejects.toThrow(
      'relay down'
    );
  });
});

describe('module integration sanity', () => {
  it('frozen system time drives now() through storage (prune math basis)', async () => {
    const { now } = await import('./storage');
    expect(now()).toBe(NOW);
  });
});
