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
  getFollowItems,
  setFollowItems,
  clearFollowItems,
  getAllFollowedPubkeys,
  getAllFollowsWithStatus,
  isFollowing,
  getFollowPetname,
  followUser,
  unfollowUser,
  isPrivateFollowsEnabled,
  setPrivateFollowsEnabled,
  isMigratedToFileStorage,
  setMigratedToFileStorage,
} from './follows';

const PK1 = '11'.repeat(32);
const PK2 = '22'.repeat(32);

describe('follows CRUD', () => {
  beforeEach(() => clearFollowItems());

  it('followUser adds a new public follow with timestamp', () => {
    followUser(PK1, false);
    const items = getFollowItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: PK1,
      pubkey: PK1,
      isPrivate: false,
    });
    expect(typeof items[0]!.addedAt).toBe('number');
  });

  it('followUser stores relay and petname when given', () => {
    followUser(PK1, false, 'wss://someserver', 'alice');
    expect(getFollowItems()[0]).toMatchObject({
      relay: 'wss://someserver',
      petname: 'alice',
    });
  });

  it('followUser updates the existing entry instead of duplicating', () => {
    followUser(PK1, false);
    followUser(PK1, true, undefined, 'bob');
    const items = getFollowItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ isPrivate: true, petname: 'bob' });
  });

  it('followUser update keeps relay/petname when not provided', () => {
    followUser(PK1, false, 'wss://someserver', 'alice');
    followUser(PK1, false);
    expect(getFollowItems()[0]).toMatchObject({
      relay: 'wss://someserver',
      petname: 'alice',
    });
  });

  it('unfollowUser removes the follow', () => {
    followUser(PK1, false);
    unfollowUser(PK1);
    expect(getFollowItems()).toEqual([]);
  });

  it('unfollowUser is a no-op for an unknown pubkey', () => {
    followUser(PK1, false);
    unfollowUser(PK2);
    expect(getFollowItems()).toHaveLength(1);
  });

  it('isFollowing reports public/private variants (one entry per pubkey)', () => {
    expect(isFollowing(PK1)).toEqual({ public: false, private: false });
    followUser(PK1, false);
    expect(isFollowing(PK1)).toEqual({ public: true, private: false });
    // Re-following with privacy flips the existing entry (no second entry).
    followUser(PK1, true);
    expect(isFollowing(PK1)).toEqual({ public: false, private: true });
  });

  it('isFollowing reports both variants for dual entries (legacy/relay data)', () => {
    setFollowItems([
      { id: PK1, pubkey: PK1, isPrivate: false, addedAt: 1 },
      { id: `${PK1}p`, pubkey: PK1, isPrivate: true, addedAt: 2 },
    ]);
    expect(isFollowing(PK1)).toEqual({ public: true, private: true });
  });

  it('getFollowPetname returns the petname of the public follow only', () => {
    followUser(PK1, false, undefined, 'alice');
    expect(getFollowPetname(PK1)).toBe('alice');
  });

  it('getFollowPetname returns null for private-only follows', () => {
    followUser(PK1, true, undefined, 'secret');
    expect(getFollowPetname(PK1)).toBeNull();
  });

  it('getFollowPetname returns null when no petname is set', () => {
    followUser(PK1, false);
    expect(getFollowPetname(PK1)).toBeNull();
  });

  it('getFollowPetname returns null for unknown pubkeys', () => {
    expect(getFollowPetname(PK2)).toBeNull();
  });

  it('getAllFollowedPubkeys lists all follow pubkeys', () => {
    followUser(PK1, false);
    followUser(PK2, true);
    expect(getAllFollowedPubkeys().sort()).toEqual([PK1, PK2].sort());
  });

  it('getAllFollowsWithStatus merges dual entries into one status', () => {
    setFollowItems([
      { id: PK1, pubkey: PK1, isPrivate: false, addedAt: 1 },
      { id: `${PK1}p`, pubkey: PK1, isPrivate: true, addedAt: 2 },
      { id: PK2, pubkey: PK2, isPrivate: true, addedAt: 3 },
    ]);
    const status = getAllFollowsWithStatus();
    expect(status.get(PK1)).toEqual({ public: true, private: true });
    expect(status.get(PK2)).toEqual({ public: false, private: true });
    expect(status.size).toBe(2);
  });

  it('clearFollowItems empties the list', () => {
    followUser(PK1, false);
    setFollowItems(getFollowItems());
    clearFollowItems();
    expect(getFollowItems()).toEqual([]);
  });
});

describe('follows settings', () => {
  beforeEach(() => {
    clearFollowItems();
    localStorage.clear();
  });

  it('private follows flag round-trips', () => {
    expect(isPrivateFollowsEnabled()).toBe(false);
    setPrivateFollowsEnabled(true);
    expect(isPrivateFollowsEnabled()).toBe(true);
  });

  it('file-migration flag round-trips', () => {
    expect(isMigratedToFileStorage()).toBe(false);
    setMigratedToFileStorage();
    expect(isMigratedToFileStorage()).toBe(true);
  });
});
