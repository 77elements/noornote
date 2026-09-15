/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const TEST_PK = 'aa'.repeat(32);

vi.mock('./relays', () => ({
  getTransport: () => ({}),
  getReadRelays: () => [],
  getWriteRelays: () => [],
  getCurrentUserPubkey: () => TEST_PK,
  requireAuth: () => ({ pubkey: TEST_PK }),
  fetchEvents: async () => [],
  publishEvent: async () => new Set<string>(),
  signEvent: async () => null,
  encryptContent: async () => '',
  decryptContent: async () => '',
}));

vi.mock('../services/AuthService', () => ({
  AuthService: {
    getInstance: () => ({ getCurrentUser: () => ({ pubkey: TEST_PK }) }),
  },
}));

import {
  isBookmarkFolderTombstoned,
  addBookmarkFolderTombstone,
  removeBookmarkFolderTombstone,
} from './bookmarks';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';

describe('bookmark folder tombstones', () => {
  beforeEach(() => {
    PerAccountLocalStorage.getInstance().remove(
      StorageKeys.BOOKMARK_TOMBSTONES
    );
  });

  it('addBookmarkFolderTombstone marks a folder as deleted', () => {
    addBookmarkFolderTombstone('Portfolio');
    expect(isBookmarkFolderTombstoned('Portfolio')).toBe(true);
  });

  it('removeBookmarkFolderTombstone clears the marker (explicit re-creation)', () => {
    addBookmarkFolderTombstone('Portfolio');
    removeBookmarkFolderTombstone('Portfolio');
    expect(isBookmarkFolderTombstoned('Portfolio')).toBe(false);
  });

  it('removing a non-existent tombstone is a no-op', () => {
    expect(() => removeBookmarkFolderTombstone('Ghost')).not.toThrow();
    expect(isBookmarkFolderTombstoned('Ghost')).toBe(false);
  });

  it('empty folder names are never tombstoned', () => {
    addBookmarkFolderTombstone('');
    expect(isBookmarkFolderTombstoned('')).toBe(false);
  });

  it('tombstones store the deletion timestamp (seconds) per folder name', () => {
    const before = Math.floor(Date.now() / 1000);
    addBookmarkFolderTombstone('Personal');
    const map = PerAccountLocalStorage.getInstance().get<
      Record<string, number>
    >(StorageKeys.BOOKMARK_TOMBSTONES, {});
    expect(map['Personal']).toBeGreaterThanOrEqual(before);
  });

  it('tombstones live under the per-account key (multi-account isolation)', () => {
    addBookmarkFolderTombstone('Private');
    const raw = localStorage.getItem(StorageKeys.BOOKMARK_TOMBSTONES)!;
    expect(Object.keys(JSON.parse(raw) as Record<string, number>)).toEqual([
      TEST_PK,
    ]);
  });
});
