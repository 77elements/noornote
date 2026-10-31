// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Regression tests for the UnknownDMNotifier "toast for followed senders"
 *  bug: FollowCheckService's in-memory set went stale (or was never
 *  bootstrapped) because nothing subscribed it to 'follow:updated'. */

const { browserItems } = vi.hoisted(() => ({
  browserItems: [] as { pubkey: string }[],
}));

vi.mock('../lists/follows', () => ({
  FollowStorageAdapter: class {
    getBrowserItems() {
      return [...browserItems];
    }
    setBrowserItems(items: { pubkey: string }[]) {
      browserItems.splice(0, browserItems.length, ...items);
    }
    async getFileItems() {
      return [];
    }
  },
}));

vi.mock('./AuthService', () => ({
  AuthService: {
    getInstance: () => ({
      getCurrentUser: () => ({ pubkey: 'me' }),
    }),
  },
}));

import { FollowCheckService } from './FollowCheckService';
import { TypedEventBus } from '../core/TypedEventBus';

describe('FollowCheckService — follow:updated rebuild', () => {
  beforeEach(() => {
    browserItems.length = 0;
    browserItems.push({ pubkey: 'a' });
    // clear() tears down the 'follow:updated' subscription — clean per-test cycle.
    FollowCheckService.getInstance().clear();
  });

  it('isFollowingSync reflects the initialized follow set', async () => {
    const svc = FollowCheckService.getInstance();
    await svc.init();

    expect(svc.isFollowingSync('a')).toBe(true);
    expect(svc.isFollowingSync('b')).toBe(false);
  });

  it('rebuilds the set when follow:updated fires (stale-set regression)', async () => {
    const svc = FollowCheckService.getInstance();
    await svc.init();

    // A follow-list write lands in browser storage and emits follow:updated.
    browserItems.push({ pubkey: 'b' });
    TypedEventBus.getInstance().emit('follow:updated', undefined);

    expect(svc.isFollowingSync('b')).toBe(true);
    expect(svc.isFollowingSync('a')).toBe(true);
  });

  it('drops removed follows on follow:updated (stale-set regression)', async () => {
    const svc = FollowCheckService.getInstance();
    await svc.init();

    browserItems.splice(0, browserItems.length, { pubkey: 'b' });
    TypedEventBus.getInstance().emit('follow:updated', undefined);

    expect(svc.isFollowingSync('a')).toBe(false);
    expect(svc.isFollowingSync('b')).toBe(true);
  });

  it('isFollowing bootstraps an uninitialized set via init() (boot-race regression)', async () => {
    // No init() call before the check — the awaited isFollowing() must
    // bootstrap the set itself, not read an empty in-memory set.
    browserItems.push({ pubkey: 'late-comer' });
    const svc = FollowCheckService.getInstance();

    expect(await svc.isFollowing('late-comer')).toBe(true);
  });
});
