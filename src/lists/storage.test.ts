/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const TEST_PK = 'aa'.repeat(32);

vi.mock('../services/AuthService', () => ({
  AuthService: {
    getInstance: () => ({ getCurrentUser: () => ({ pubkey: TEST_PK }) }),
  },
}));

import {
  deduplicateById,
  deduplicateByPubkey,
  mergeByKey,
  mergeStringArrays,
  readList,
  writeList,
  clearList,
  getListLastModified,
  setListLastModified,
} from './storage';
import { StorageKeys } from '../services/PerAccountLocalStorage';

describe('deduplicateById', () => {
  it('removes duplicate ids, last occurrence wins', () => {
    const items = [
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
      { id: 'a', v: 3 },
    ];
    expect(deduplicateById(items)).toEqual([
      { id: 'a', v: 3 },
      { id: 'b', v: 2 },
    ]);
  });

  it('keeps the order of first appearance', () => {
    const items = [{ id: 'b' }, { id: 'a' }, { id: 'b' }];
    expect(deduplicateById(items).map(i => i.id)).toEqual(['b', 'a']);
  });

  it('empty array stays empty', () => {
    expect(deduplicateById([])).toEqual([]);
  });

  it('unique items pass through unchanged', () => {
    const items = [{ id: 'x' }, { id: 'y' }];
    expect(deduplicateById(items)).toEqual(items);
  });
});

describe('deduplicateByPubkey', () => {
  it('removes duplicate pubkeys, last occurrence wins', () => {
    const items = [
      { pubkey: 'p1', petname: 'old' },
      { pubkey: 'p1', petname: 'new' },
      { pubkey: 'p2', petname: 'x' },
    ];
    expect(deduplicateByPubkey(items)).toEqual([
      { pubkey: 'p1', petname: 'new' },
      { pubkey: 'p2', petname: 'x' },
    ]);
  });

  it('empty array stays empty', () => {
    expect(deduplicateByPubkey([])).toEqual([]);
  });
});

describe('mergeByKey', () => {
  it('union of both arrays', () => {
    const browser = [{ id: 'a' }];
    const fresh = [{ id: 'b' }];
    expect(mergeByKey(browser, fresh, 'id')).toEqual([
      { id: 'a' },
      { id: 'b' },
    ]);
  });

  it('browser item wins on duplicate keys', () => {
    const browser = [{ id: 'a', src: 'browser' }];
    const fresh = [{ id: 'a', src: 'relay' }];
    expect(mergeByKey(browser, fresh, 'id')).toEqual([
      { id: 'a', src: 'browser' },
    ]);
  });

  it('browser items come first, new items appended in relay order', () => {
    const browser = [{ id: 'b' }];
    const fresh = [{ id: 'a' }, { id: 'c' }, { id: 'b' }];
    expect(mergeByKey(browser, fresh, 'id').map(i => i.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('empty browser array takes all new items', () => {
    expect(mergeByKey([], [{ id: 'a' }], 'id')).toEqual([{ id: 'a' }]);
  });

  it('empty new array keeps browser items', () => {
    expect(mergeByKey([{ id: 'a' }], [], 'id')).toEqual([{ id: 'a' }]);
  });
});

describe('mergeStringArrays', () => {
  it('union without duplicates', () => {
    expect(mergeStringArrays(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('empty relay side keeps browser items', () => {
    expect(mergeStringArrays(['a'], [])).toEqual(['a']);
  });

  it('both empty stays empty', () => {
    expect(mergeStringArrays([], [])).toEqual([]);
  });
});

describe('readList / writeList / clearList', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips items through per-account storage', () => {
    writeList(StorageKeys.FOLLOWS, [{ id: 'a' }]);
    expect(readList(StorageKeys.FOLLOWS, [])).toEqual([{ id: 'a' }]);
  });

  it('returns defaultValue when nothing was written', () => {
    expect(readList(StorageKeys.FOLLOWS, [])).toEqual([]);
  });

  it('clearList removes the data', () => {
    writeList(StorageKeys.MUTES, [{ id: 'a' }]);
    clearList(StorageKeys.MUTES);
    expect(readList(StorageKeys.MUTES, [])).toEqual([]);
  });

  it('is per-account isolated (other pubkeys see their own data)', () => {
    writeList(StorageKeys.FOLLOWS, [{ id: 'mine' }]);
    // Same storage under a different account map entry must not leak into ours.
    const mapStr = localStorage.getItem(StorageKeys.FOLLOWS);
    expect(mapStr).toContain(TEST_PK);
  });
});

describe('getListLastModified / setListLastModified', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to 0 for all list types', () => {
    for (const listType of [
      'follows',
      'bookmarks',
      'mutes',
      'tribes',
    ] as const) {
      expect(getListLastModified(listType)).toBe(0);
    }
  });

  it('stores and reads back an explicit timestamp per list type', () => {
    setListLastModified('follows', 1000);
    setListLastModified('mutes', 2000);
    expect(getListLastModified('follows')).toBe(1000);
    expect(getListLastModified('mutes')).toBe(2000);
    expect(getListLastModified('bookmarks')).toBe(0);
  });

  it('setListLastModified without timestamp stamps now()', () => {
    const before = Math.floor(Date.now() / 1000);
    setListLastModified('tribes');
    expect(getListLastModified('tribes')).toBeGreaterThanOrEqual(before);
  });
});
