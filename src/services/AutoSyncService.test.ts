/* eslint-disable camelcase -- Nostr protocol event fields are snake_case by spec */
/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

const TEST_PK = 'aa'.repeat(32);
const NOW = 1_800_000_000;

const authState = vi.hoisted(() => ({
  currentUser: { pubkey: 'aa'.repeat(32), npub: 'npub1testuser' },
  isBunkerAuth: false,
}));
const connectivityState = vi.hoisted(() => ({ online: true }));
// Stable object — module-level consumers (file.ts etc.) capture getInstance()
// once, so flipping a property must be visible through the captured reference.
const platformState = vi.hoisted(() => ({
  isDesktop: false,
  isBrowser: true,
  isMobile: false,
  isNative: false,
}));
const addonState = vi.hoisted(() => ({ bookmarks: true, tribes: true }));

const relay = vi.hoisted(() => ({
  kind3Events: [] as unknown[],
  mutesEvents: [] as unknown[],
  bookmarkSetEvents: [] as unknown[],
  bookmarkDeletionEvents: [] as unknown[],
  bookmarkOrderEvents: [] as unknown[],
  bookmarkDeletionRecord: [] as unknown[],
  tribeSetEvents: [] as unknown[],
  tribeDeletionEvents: [] as unknown[],
  tribeOrderEvents: [] as unknown[],
  tribeDeletionRecord: [] as unknown[],
  published: [] as Array<{ kind: number; tags: string[][]; content: string }>,
}));

function resetRelay(): void {
  relay.kind3Events = [];
  relay.mutesEvents = [];
  relay.bookmarkSetEvents = [];
  relay.bookmarkDeletionEvents = [];
  relay.bookmarkOrderEvents = [];
  relay.bookmarkDeletionRecord = [];
  relay.tribeSetEvents = [];
  relay.tribeDeletionEvents = [];
  relay.tribeOrderEvents = [];
  relay.tribeDeletionRecord = [];
  relay.published = [];
}

vi.mock('./AuthService', () => ({
  AuthService: {
    getInstance: () => ({
      getCurrentUser: () => authState.currentUser,
      isBunkerAuth: () => authState.isBunkerAuth,
    }),
  },
}));

vi.mock('./ConnectivityService', () => ({
  ConnectivityService: {
    getInstance: () => ({ isOnline: () => connectivityState.online }),
  },
}));

vi.mock('./PlatformService', () => ({
  PlatformService: {
    getInstance: () => platformState,
  },
}));

vi.mock('./DataSaverService', () => ({
  isDataSaverEnabled: () => false,
}));

vi.mock('../addons/bookmarks/index', () => ({
  isBookmarksEnabled: () => addonState.bookmarks,
  isReadSyncEnabled: () => false,
}));

vi.mock('../addons/tribes/index', () => ({
  isTribesEnabled: () => addonState.tribes,
}));

vi.mock('../lists/relays', () => ({
  getTransport: () => ({}),
  getReadRelays: () => [],
  getWriteRelays: () => ['wss://relay'],
  getCurrentUserPubkey: () => 'aa'.repeat(32),
  requireAuth: () => ({ pubkey: 'aa'.repeat(32) }),
  fetchEvents: async (
    filters: Array<{ kinds?: number[]; '#d'?: string[] }>
  ): Promise<unknown[]> => {
    const f = filters[0] ?? {};
    const dTags = f['#d'] ?? [];
    if (dTags.includes('noornote:bookmark-deletions'))
      return relay.bookmarkDeletionRecord;
    if (dTags.includes('noornote:bookmark-folders-order'))
      return relay.bookmarkOrderEvents;
    if (dTags.includes('noornote:tribe-deletions'))
      return relay.tribeDeletionRecord;
    if (dTags.includes('noornote:tribe-folders-order'))
      return relay.tribeOrderEvents;
    switch (f.kinds?.[0]) {
      case 3:
        return relay.kind3Events;
      case 10000:
        return relay.mutesEvents;
      case 30003:
        return relay.bookmarkSetEvents;
      case 30000:
        return relay.tribeSetEvents;
      case 5:
        return relay.bookmarkDeletionEvents;
      default:
        return [];
    }
  },
  publishEvent: async (event: {
    kind: number;
    tags: string[][];
    content: string;
  }) => {
    relay.published.push(event);
    return new Set(['wss://relay']);
  },
  signEvent: async (event: {
    kind: number;
    tags: string[][];
    content: string;
  }) => ({
    ...event,
    id: 'de'.repeat(32),
    sig: 'ff'.repeat(64),
  }),
  encryptContent: async () => '',
  decryptContent: async () => null,
}));

import { AutoSyncService } from './AutoSyncService';
import { TypedEventBus } from '../core/TypedEventBus';
import { getListLastModified, setListLastModified } from '../lists/storage';
import { getFollowItems, type FollowItem } from '../lists/follows';
import { getMuteItems } from '../lists/mutes';
import {
  readBrowserBookmarks,
  getBookmarkFolderService,
  type BookmarkItem,
} from '../lists/bookmarks';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';

const storage = PerAccountLocalStorage.getInstance();
const bus = TypedEventBus.getInstance();

const PK_OLD = '01'.repeat(32);
const PK_NEW = '02'.repeat(32);
const ITEM_A = 'a1'.padEnd(64, '0');
const ITEM_B = 'b1'.padEnd(64, '0');

function follow(pubkey: string): FollowItem {
  return { id: pubkey, pubkey, addedAt: NOW, isPrivate: false };
}

function kind3Event(created_at: number, pubkeys: string[]): NostrEvent {
  return {
    kind: 3,
    id: `k3-${created_at}`,
    pubkey: TEST_PK,
    created_at,
    tags: pubkeys.map(pk => ['p', pk]),
    content: '',
    sig: 'ff'.repeat(64),
  } as unknown as NostrEvent;
}

function muteEvent(created_at: number, pubkeys: string[]): NostrEvent {
  return {
    kind: 10000,
    id: `k10000-${created_at}`,
    pubkey: TEST_PK,
    created_at,
    tags: pubkeys.map(pk => ['p', pk]),
    content: '',
    sig: 'ff'.repeat(64),
  } as unknown as NostrEvent;
}

function bookmarkSetEvent(
  dTag: string,
  created_at: number,
  itemIds: string[]
): NostrEvent {
  return {
    kind: 30003,
    id: `bm-${dTag}-${created_at}`,
    pubkey: TEST_PK,
    created_at,
    tags: [['d', dTag], ...itemIds.map(id => ['e', id])],
    content: '',
    sig: 'ff'.repeat(64),
  } as unknown as NostrEvent;
}

function bookmarkOrderEvent(created_at: number, order: string[]): NostrEvent {
  return {
    kind: 30078,
    id: `bmo-${created_at}`,
    pubkey: TEST_PK,
    created_at,
    tags: [
      ['d', 'noornote:bookmark-folders-order'],
      ...order.map(d => ['a', `30003:${TEST_PK}:${d}`]),
    ],
    content: JSON.stringify({ order }),
    sig: 'ff'.repeat(64),
  } as unknown as NostrEvent;
}

function bookmarkDeletionEvent(created_at: number, folder: string): NostrEvent {
  return {
    kind: 5,
    id: `bmdel-${created_at}-${folder}`,
    pubkey: TEST_PK,
    created_at,
    tags: [['a', `30003:${TEST_PK}:${folder}`]],
    content: '',
    sig: 'ff'.repeat(64),
  } as unknown as NostrEvent;
}

function bookmarkItem(id: string): BookmarkItem {
  return { id, type: 'e', value: id, addedAt: NOW };
}

/** Seed follows WITHOUT emitting follow:updated (would trigger the push path). */
function seedFollowsSilently(items: FollowItem[]): void {
  storage.set(StorageKeys.FOLLOWS, items);
}

/** Seed two local bookmark folders A + B with one item each. */
function seedBookmarkFolders(): void {
  const folders = [
    { id: 'folder_A', name: 'A', createdAt: (NOW - 5000) * 1000 },
    { id: 'folder_B', name: 'B', createdAt: (NOW - 5000) * 1000 },
  ];
  storage.set(StorageKeys.BOOKMARK_FOLDERS, folders);
  storage.set(StorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS, [
    { bookmarkId: ITEM_A, folderId: 'folder_A', order: 0 },
    { bookmarkId: ITEM_B, folderId: 'folder_B', order: 0 },
  ]);
  storage.set(StorageKeys.BOOKMARK_ROOT_ORDER, [
    { type: 'folder', id: 'folder_A' },
    { type: 'folder', id: 'folder_B' },
  ]);
  const write = (items: BookmarkItem[]) =>
    storage.set(StorageKeys.BOOKMARKS, items);
  write([bookmarkItem(ITEM_A), bookmarkItem(ITEM_B)]);
}

function publishedKinds(kind: number): number {
  return relay.published.filter(p => p.kind === kind).length;
}

async function runScheduledSync(): Promise<void> {
  await vi.advanceTimersByTimeAsync(10_000);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW * 1000));
  localStorage.clear();
  resetRelay();
  connectivityState.online = true;
  platformState.isDesktop = false;
  addonState.bookmarks = true;
  addonState.tribes = true;
  authState.currentUser = { pubkey: TEST_PK, npub: 'npub1testuser' };
  authState.isBunkerAuth = false;
  const service = AutoSyncService.getInstance();
  // Cancel the constructor's startup-sync timer so tests start from a clean slate.
  bus.emit('user:logout');
  void service;
});

afterEach(() => {
  bus.emit('user:logout');
  vi.useRealTimers();
  localStorage.clear();
});

// ===========================================================================
// Pull path (Easy Mode): startup / periodic / scheduled sync
// ===========================================================================

describe('AutoSyncService pull (timestamp-based, no modal)', () => {
  it('relay newer → applies the relay version and adopts its timestamp', async () => {
    seedFollowsSilently([follow(PK_OLD)]);
    setListLastModified('follows', NOW - 200);
    relay.kind3Events = [kind3Event(NOW, [PK_NEW])];

    AutoSyncService.getInstance().scheduleSyncForList('follows');
    await runScheduledSync();

    expect(getFollowItems().map(i => i.pubkey)).toEqual([PK_NEW]);
    expect(getListLastModified('follows')).toBe(NOW);
  });

  it('local newer → pushes the local version to the relays (local state untouched)', async () => {
    seedFollowsSilently([follow(PK_OLD)]);
    setListLastModified('follows', NOW);
    relay.kind3Events = [kind3Event(NOW - 100, [PK_NEW])];

    AutoSyncService.getInstance().scheduleSyncForList('follows');
    await runScheduledSync();

    expect(publishedKinds(3)).toBe(1);
    const kind3 = relay.published.find(p => p.kind === 3)!;
    expect(kind3.tags).toContainEqual(['p', PK_OLD]);
    expect(getFollowItems().map(i => i.pubkey)).toEqual([PK_OLD]);
  });

  it('equal timestamps → pushes local (else-branch documents current behavior)', async () => {
    seedFollowsSilently([follow(PK_OLD)]);
    setListLastModified('follows', NOW);
    relay.kind3Events = [kind3Event(NOW, [PK_NEW])];

    AutoSyncService.getInstance().scheduleSyncForList('follows');
    await runScheduledSync();

    expect(publishedKinds(3)).toBe(1);
  });

  it('relay empty + local items would be removed → skipped (empty-relay safety)', async () => {
    seedFollowsSilently([follow(PK_OLD)]);
    setListLastModified('follows', NOW - 200);
    relay.kind3Events = [];

    AutoSyncService.getInstance().scheduleSyncForList('follows');
    await runScheduledSync();

    expect(getFollowItems().map(i => i.pubkey)).toEqual([PK_OLD]);
    expect(getListLastModified('follows')).toBe(NOW - 200);
    expect(publishedKinds(3)).toBe(0);
  });

  it('no differences at all → no action, no publish', async () => {
    seedFollowsSilently([follow(PK_OLD)]);
    setListLastModified('follows', NOW - 200);
    relay.kind3Events = [kind3Event(NOW - 200, [PK_OLD])];

    AutoSyncService.getInstance().scheduleSyncForList('follows');
    await runScheduledSync();

    expect(publishedKinds(3)).toBe(0);
    expect(getFollowItems().map(i => i.pubkey)).toEqual([PK_OLD]);
  });

  it('mutes: relay newer → overwrite applied', async () => {
    storage.set(StorageKeys.MUTES, [
      { type: 'user', id: PK_OLD, isPrivate: false, addedAt: NOW - 500 },
    ]);
    setListLastModified('mutes', NOW - 200);
    relay.mutesEvents = [muteEvent(NOW, [PK_NEW])];

    AutoSyncService.getInstance().scheduleSyncForList('mutes');
    await runScheduledSync();

    expect(getMuteItems().map(i => i.id)).toEqual([PK_NEW]);
    expect(getListLastModified('mutes')).toBe(NOW);
  });
});

// ===========================================================================
// applyOverwrite sanity check (Mass-Deletion protection, 2026-04-30)
// ===========================================================================

describe('AutoSyncService bookmark applyOverwrite sanity check', () => {
  it('refuses the overwrite when folders would vanish without kind:5 proof', async () => {
    seedBookmarkFolders();
    setListLastModified('bookmarks', NOW - 200);
    // Relay only knows folder A — B is missing WITHOUT a deletion marker.
    relay.bookmarkSetEvents = [bookmarkSetEvent('A', NOW, [ITEM_A])];
    relay.bookmarkOrderEvents = [bookmarkOrderEvent(NOW, ['A'])];

    AutoSyncService.getInstance().scheduleSyncForList('bookmarks');
    await runScheduledSync();

    // Nothing was applied: both items and both folders survive untouched.
    expect(
      readBrowserBookmarks()
        .map(i => i.id)
        .sort()
    ).toEqual([ITEM_A, ITEM_B].sort());
    expect(
      getBookmarkFolderService()
        .getFolders()
        .map(f => f.name)
    ).toEqual(['A', 'B']);
    expect(getListLastModified('bookmarks')).toBe(NOW - 200);
    expect(publishedKinds(30003)).toBe(0);
  });

  it('applies the overwrite when the removal has kind:5 proof', async () => {
    seedBookmarkFolders();
    setListLastModified('bookmarks', NOW - 200);
    relay.bookmarkSetEvents = [bookmarkSetEvent('A', NOW, [ITEM_A])];
    relay.bookmarkOrderEvents = [bookmarkOrderEvent(NOW, ['A'])];
    relay.bookmarkDeletionEvents = [bookmarkDeletionEvent(NOW - 100, 'B')];

    AutoSyncService.getInstance().scheduleSyncForList('bookmarks');
    await runScheduledSync();

    expect(readBrowserBookmarks().map(i => i.id)).toEqual([ITEM_A]);
    expect(
      getBookmarkFolderService()
        .getFolders()
        .map(f => f.name)
    ).toEqual(['A']);
    expect(getListLastModified('bookmarks')).toBe(NOW);
  });
});

// ===========================================================================
// Push path (Easy Mode): change → file + relay
// ===========================================================================

describe('AutoSyncService push (change-driven)', () => {
  it('follows changes are pushed with a 2.5s debounce and collapsed', async () => {
    seedFollowsSilently([follow(PK_OLD)]);
    bus.emit('follow:updated');
    bus.emit('follow:updated'); // within the debounce window → collapses

    await vi.advanceTimersByTimeAsync(2600);

    expect(publishedKinds(3)).toBe(1);
    expect(getListLastModified('follows')).toBe(NOW);
  });

  it('mutes are pushed immediately (no debounce — unmute protection)', async () => {
    storage.set(StorageKeys.MUTES, [
      { type: 'user', id: PK_OLD, isPrivate: false, addedAt: NOW },
    ]);
    bus.emit('mute:updated');
    await vi.advanceTimersByTimeAsync(0);

    expect(publishedKinds(10000)).toBe(1);
  });

  it('saves the list to file first on desktop', async () => {
    const writes: string[] = [];
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      getHomeDir: async () => '/home/test',
      fsExists: async () => false,
      fsMkdir: async () => undefined,
      writeTextFile: async (path: string) => {
        writes.push(path);
      },
      readTextFile: async () => '[]',
    };
    platformState.isDesktop = true;
    seedFollowsSilently([follow(PK_OLD)]);

    bus.emit('follow:updated');
    await vi.advanceTimersByTimeAsync(2600);

    expect(writes.length).toBeGreaterThanOrEqual(2); // public + private follows file
    expect(writes.some(p => p.includes('follows-public.json'))).toBe(true);
    expect(publishedKinds(3)).toBe(1);
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('manual mode → change events trigger nothing', async () => {
    storage.set(StorageKeys.LIST_SYNC_MODE, 'manual');
    seedFollowsSilently([follow(PK_OLD)]);
    bus.emit('follow:updated');
    await vi.advanceTimersByTimeAsync(3000);
    expect(publishedKinds(3)).toBe(0);
  });

  it('disabled bookmarks addon → bookmark changes are not synced', async () => {
    addonState.bookmarks = false;
    readBrowserBookmarks();
    bus.emit('bookmark:updated');
    await vi.advanceTimersByTimeAsync(3000);
    expect(publishedKinds(30003)).toBe(0);
  });

  it('offline → relay sync skipped', async () => {
    connectivityState.online = false;
    seedFollowsSilently([follow(PK_OLD)]);
    bus.emit('follow:updated');
    await vi.advanceTimersByTimeAsync(3000);
    expect(publishedKinds(3)).toBe(0);
  });
});
