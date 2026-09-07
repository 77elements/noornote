import { describe, it, expect } from 'vitest';
import {
  mergeBookmarkReadMaps,
  pruneReadMap,
  type BookmarkReadMap,
} from './bookmarkReadMerge';

describe('mergeBookmarkReadMaps', () => {
  it('union of both maps, newest readAt wins per id', () => {
    const local: BookmarkReadMap = { a: 100, b: 500 };
    const remote: BookmarkReadMap = { a: 300, c: 700 };
    const existing = new Set(['a', 'b', 'c']);
    expect(mergeBookmarkReadMaps(local, remote, existing)).toEqual({
      a: 300, // remote newer
      b: 500, // only local
      c: 700, // only remote
    });
  });

  it('prunes markers for deleted bookmarks', () => {
    const local: BookmarkReadMap = { a: 100, deleted: 200 };
    const remote: BookmarkReadMap = { a: 300, deleted: 400 };
    const existing = new Set(['a']);
    expect(mergeBookmarkReadMaps(local, remote, existing)).toEqual({
      a: 300,
    });
  });

  it('empty remote (no relay event) keeps local state', () => {
    const local: BookmarkReadMap = { a: 100 };
    expect(mergeBookmarkReadMaps(local, {}, new Set(['a']))).toEqual({
      a: 100,
    });
  });

  it('empty local (fresh device) takes remote state', () => {
    const remote: BookmarkReadMap = { a: 100, b: 200 };
    expect(mergeBookmarkReadMaps({}, remote, new Set(['a', 'b']))).toEqual(
      remote
    );
  });
});

describe('pruneReadMap', () => {
  it('drops markers whose bookmark no longer exists', () => {
    const map: BookmarkReadMap = { a: 1, gone: 2, b: 3 };
    expect(pruneReadMap(map, new Set(['a', 'b']))).toEqual({ a: 1, b: 3 });
  });

  it('returns empty for an empty existing set', () => {
    expect(pruneReadMap({ a: 1 }, new Set())).toEqual({});
  });
});
