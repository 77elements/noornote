/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

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
  getMuteItems,
  clearMuteItems,
  getAllMutedUsers,
  getAllMutedUsersWithStatus,
  isUserMuted,
  muteUser,
  unmuteUser,
  unmuteUserCompletely,
  getAllMutedThreads,
  getAllMutedThreadsWithStatus,
  isThreadMuted,
  muteThread,
  unmuteThread,
  isInMutedThread,
  isPrivateMutesEnabled,
  setPrivateMutesEnabled,
  getEncryptionMethod,
  setEncryptionMethod,
} from './mutes';

const PK1 = '11'.repeat(32);
const PK2 = '22'.repeat(32);
const THREAD1 = 'c0'.repeat(32);
const THREAD2 = 'c1'.repeat(32);

function eventWith(id: string, tags: string[][] = []): NostrEvent {
  return { id, tags } as unknown as NostrEvent;
}

describe('mute users', () => {
  beforeEach(() => clearMuteItems());

  it('muteUser adds a user-type item with privacy flag and timestamp', () => {
    muteUser(PK1, false);
    const items = getMuteItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'user',
      id: PK1,
      isPrivate: false,
    });
    expect(typeof items[0]!.addedAt).toBe('number');
  });

  it('muteUser is idempotent for the same pubkey+privacy', () => {
    muteUser(PK1, false);
    muteUser(PK1, false);
    expect(getMuteItems()).toHaveLength(1);
  });

  it('muteUser keeps public and private mutes as separate entries', () => {
    muteUser(PK1, false);
    muteUser(PK1, true);
    expect(getMuteItems()).toHaveLength(2);
  });

  it('unmuteUser removes only the matching privacy variant', () => {
    muteUser(PK1, false);
    muteUser(PK1, true);
    unmuteUser(PK1, false);
    expect(getMuteItems()).toHaveLength(1);
    expect(getMuteItems()[0]!.isPrivate).toBe(true);
  });

  it('unmuteUserCompletely removes both variants', () => {
    muteUser(PK1, false);
    muteUser(PK1, true);
    unmuteUserCompletely(PK1);
    expect(getMuteItems()).toEqual([]);
  });

  it('unmuteUser is a no-op for an unknown pubkey', () => {
    muteUser(PK1, false);
    unmuteUser(PK2, false);
    expect(getMuteItems()).toHaveLength(1);
  });

  it('isUserMuted reports public/private/any correctly', () => {
    expect(isUserMuted(PK1)).toEqual({
      public: false,
      private: false,
      any: false,
    });
    muteUser(PK1, false);
    expect(isUserMuted(PK1)).toEqual({
      public: true,
      private: false,
      any: true,
    });
    muteUser(PK1, true);
    expect(isUserMuted(PK1)).toEqual({
      public: true,
      private: true,
      any: true,
    });
  });

  it('getAllMutedUsers lists user ids only (no thread entries)', () => {
    muteUser(PK1, false);
    muteThread(THREAD1);
    expect(getAllMutedUsers()).toEqual([PK1]);
  });

  it('getAllMutedUsersWithStatus merges dual entries into one status', () => {
    muteUser(PK1, false);
    muteUser(PK1, true);
    muteUser(PK2, true);
    const status = getAllMutedUsersWithStatus();
    expect(status.get(PK1)).toEqual({
      public: true,
      private: true,
      any: true,
    });
    expect(status.get(PK2)).toEqual({
      public: false,
      private: true,
      any: true,
    });
    expect(status.size).toBe(2);
  });
});

describe('mute threads', () => {
  beforeEach(() => clearMuteItems());

  it('muteThread adds a thread-type item (private by default)', () => {
    muteThread(THREAD1);
    expect(getMuteItems()[0]).toMatchObject({
      type: 'thread',
      id: THREAD1,
      isPrivate: true,
    });
    expect(isThreadMuted(THREAD1)).toBe(true);
  });

  it('muteThread is idempotent', () => {
    muteThread(THREAD1);
    muteThread(THREAD1);
    expect(getMuteItems()).toHaveLength(1);
  });

  it('unmuteThread removes the thread mute', () => {
    muteThread(THREAD1);
    unmuteThread(THREAD1);
    expect(isThreadMuted(THREAD1)).toBe(false);
  });

  it('getAllMutedThreads lists thread ids only', () => {
    muteUser(PK1, false);
    muteThread(THREAD1);
    muteThread(THREAD2, false);
    expect(getAllMutedThreads().sort()).toEqual([THREAD1, THREAD2].sort());
  });

  it('getAllMutedThreadsWithStatus reports the privacy flag', () => {
    muteThread(THREAD2, false);
    expect(getAllMutedThreadsWithStatus().get(THREAD2)).toEqual({
      public: true,
      private: false,
      any: true,
    });
  });

  it('isInMutedThread matches the event id itself', () => {
    muteThread(THREAD1);
    expect(isInMutedThread(eventWith(THREAD1))).toBe(true);
  });

  it('isInMutedThread matches e-tag references (root/reply/mention)', () => {
    muteThread(THREAD1);
    const reply = eventWith('ff'.repeat(32), [['e', THREAD1]]);
    expect(isInMutedThread(reply)).toBe(true);
  });

  it('isInMutedThread returns false for unrelated events', () => {
    muteThread(THREAD1);
    expect(isInMutedThread(eventWith('ee'.repeat(32), [['e', THREAD2]]))).toBe(
      false
    );
    expect(isInMutedThread(eventWith('ee'.repeat(32)))).toBe(false);
  });

  it('isInMutedThread short-circuits on an empty mute list', () => {
    expect(isInMutedThread(eventWith(THREAD1, [['e', THREAD1]]))).toBe(false);
  });
});

describe('mute settings', () => {
  beforeEach(() => {
    clearMuteItems();
    localStorage.clear();
  });

  it('private mutes flag round-trips', () => {
    expect(isPrivateMutesEnabled()).toBe(false);
    setPrivateMutesEnabled(true);
    expect(isPrivateMutesEnabled()).toBe(true);
  });

  it('encryption method defaults to nip44', () => {
    expect(getEncryptionMethod()).toBe('nip44');
  });

  it('encryption method round-trips nip04', () => {
    setEncryptionMethod('nip04');
    expect(getEncryptionMethod()).toBe('nip04');
  });

  it('encryption method falls back to nip44 for unknown values', () => {
    setEncryptionMethod('nip04');
    localStorage.setItem(
      'noornote_mute_encryption_method_map',
      JSON.stringify({ [TEST_PK]: 'bogus' })
    );
    expect(getEncryptionMethod()).toBe('nip44');
  });
});
