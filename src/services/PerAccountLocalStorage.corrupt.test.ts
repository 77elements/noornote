// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Regression test: a corrupt JSON map in localStorage must not poison
 * PerAccountLocalStorage.setForPubkey forever. Found in the wild: a torn
 * multi-tab write corrupted the notifications cache map, after which EVERY
 * write to that key threw SyntaxError and the Notifications view died on
 * mount (blank view + stuck 99+ badge). setForPubkey must self-heal by
 * resetting the map on parse failure (mirrors getForPubkey/removeForPubkey,
 * which already swallow parse errors).
 */

import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';

// PerAccountLocalStorage imports AuthService, which pulls in the heavy
// transport chain — mock it like AutoSyncService.test.ts does.
vi.mock('./AuthService', () => ({
  AuthService: {
    getInstance: () => ({
      getCurrentUser: () => ({ pubkey: 'pk-test', npub: 'npub1test' }),
      isBunkerAuth: () => false,
    }),
  },
}));

describe('PerAccountLocalStorage — corrupt JSON self-healing', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('setForPubkey recovers when the stored map is corrupt JSON', () => {
    localStorage.setItem(
      StorageKeys.NOTIFICATIONS_CACHE,
      '{"pubkey-a": {"unread": 5}, BROKEN' // torn write → invalid JSON
    );

    // Must not throw…
    expect(() =>
      PerAccountLocalStorage.getInstance().setForPubkey(
        StorageKeys.NOTIFICATIONS_CACHE,
        'pubkey-b',
        { unread: 1 }
      )
    ).not.toThrow();

    // …and must have overwritten the corrupt entry with a valid map.
    const healed = JSON.parse(
      localStorage.getItem(StorageKeys.NOTIFICATIONS_CACHE) ?? '{}'
    ) as { 'pubkey-b': { unread: number } };
    expect(healed).toEqual({ 'pubkey-b': { unread: 1 } });
  });

  it('a normal write roundtrip still works after a healed corrupt map', () => {
    localStorage.setItem(StorageKeys.MUTES, 'CORRUPT{');

    const storage = PerAccountLocalStorage.getInstance();
    storage.setForPubkey(StorageKeys.MUTES, 'pk-1', [
      { type: 'user', id: 'x' },
    ]);
    storage.setForPubkey(StorageKeys.MUTES, 'pk-2', [
      { type: 'user', id: 'y' },
    ]);

    const map = storage.getMap<{ type: string; id: string }[]>(
      StorageKeys.MUTES
    );
    expect(map['pk-2']).toEqual([{ type: 'user', id: 'y' }]);
  });
});
