/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import {
  createEmptyBookmarkSetData,
  migrateFromOldFormat,
  isOldFormat,
  isNewFormat,
  getAllBookmarkValues,
  isValueBookmarked,
  addBookmarkToSetData,
  removeBookmarkFromSetData,
  moveBookmarkInSetData,
  createSetInData,
  deleteSetFromData,
  extractItemsFromSetData,
  extractFolderDataFromSetData,
  type BookmarkSetData,
  type BookmarkTag,
} from './bookmarks';

function rootSetOf(data: BookmarkSetData) {
  const root = data.sets.find(s => s.d === '');
  expect(root).toBeDefined();
  return root!;
}

function tag(type: 'e' | 'a' | 't' | 'r', value: string): BookmarkTag {
  return { type, value };
}

describe('createEmptyBookmarkSetData', () => {
  it('creates version-2 data with an empty root set', () => {
    const data = createEmptyBookmarkSetData();
    expect(data.version).toBe(2);
    expect(data.sets).toHaveLength(1);
    expect(data.sets[0]!.d).toBe('');
    expect(data.sets[0]!.publicTags).toEqual([]);
    expect(data.sets[0]!.privateTags).toEqual([]);
    expect(data.metadata.setOrder).toEqual(['']);
    expect(typeof data.metadata.lastModified).toBe('number');
  });
});

describe('format guards', () => {
  it('isOldFormat detects the legacy items-array format', () => {
    expect(
      isOldFormat({
        items: [{ id: 'a', type: 'e', value: 'x' }],
        lastModified: 1,
      })
    ).toBe(true);
  });

  it('isOldFormat rejects new-format data and garbage', () => {
    expect(isOldFormat(createEmptyBookmarkSetData())).toBe(false);
    expect(isOldFormat(null)).toBe(false);
    expect(isOldFormat('nope')).toBe(false);
    expect(isOldFormat({})).toBe(false);
  });

  it('isNewFormat detects version-2 sets format', () => {
    expect(isNewFormat(createEmptyBookmarkSetData())).toBe(true);
  });

  it('isNewFormat rejects old format and garbage', () => {
    expect(isNewFormat({ items: [], lastModified: 1 })).toBe(false);
    expect(isNewFormat(null)).toBe(false);
    expect(isNewFormat({ version: 2 })).toBe(false);
  });
});

describe('migrateFromOldFormat', () => {
  const oldData = {
    items: [
      { id: 'note1', type: 'e' as const, value: 'note1', isPrivate: false },
      { id: 'note2', type: 'e' as const, value: 'note2', isPrivate: true },
      { id: 'link1', type: 'r' as const, value: 'https://x', isPrivate: false },
    ],
    folders: [
      { id: 'f1', name: 'Work' },
      { id: 'f2', name: 'OrphanFolder' },
    ],
    folderAssignments: [
      { bookmarkId: 'note1', folderId: 'f1', order: 0 },
      { bookmarkId: 'link1', folderId: 'no-such-folder', order: 0 },
    ],
    rootOrder: [{ type: 'folder' as const, id: 'f1' }],
    lastModified: 12345,
  };

  it('assigns items to their folder sets in assignment order', () => {
    const data = migrateFromOldFormat(oldData);
    const work = data.sets.find(s => s.d === 'Work');
    expect(work).toBeDefined();
    expect(work!.publicTags.map(t => t.value)).toEqual(['note1']);
  });

  it('keeps the private flag when routing items into sets', () => {
    const data = migrateFromOldFormat(oldData);
    // note2 has no assignment → root, and isPrivate → privateTags
    const root = rootSetOf(data);
    expect(root.privateTags.map(t => t.value)).toEqual(['note2']);
    expect(root.publicTags.map(t => t.value)).toContain('https://x');
  });

  it('routes items with unknown folder assignments to root', () => {
    const data = migrateFromOldFormat(oldData);
    const root = rootSetOf(data);
    expect(root.publicTags.map(t => t.value)).toContain('https://x');
    const orphan = data.sets.find(s => s.d === 'OrphanFolder');
    expect(orphan).toBeDefined();
    expect(orphan!.publicTags).toEqual([]);
  });

  it('builds setOrder from rootOrder first, then appends missing folders', () => {
    const data = migrateFromOldFormat(oldData);
    expect(data.metadata.setOrder).toEqual(['', 'Work', 'OrphanFolder']);
  });

  it('preserves lastModified from the old data', () => {
    expect(migrateFromOldFormat(oldData).metadata.lastModified).toBe(12345);
  });

  it('handles empty old data gracefully', () => {
    const data = migrateFromOldFormat({ items: [], lastModified: 0 });
    expect(data.sets).toHaveLength(1);
    expect(data.metadata.setOrder).toEqual(['']);
  });
});

describe('getAllBookmarkValues', () => {
  it('unions public and private tags across all sets, deduplicated', () => {
    const data = createEmptyBookmarkSetData();
    addBookmarkToSetData(data, '', tag('e', 'a'), false);
    addBookmarkToSetData(data, '', tag('e', 'a'), true); // same value, private
    addBookmarkToSetData(data, '', tag('r', 'https://x'), false);
    addBookmarkToSetData(data, 'Work', tag('t', 'nostr'), false);
    expect(getAllBookmarkValues(data)).toEqual(['a', 'https://x', 'nostr']);
  });
});

describe('isValueBookmarked', () => {
  it('finds a public bookmark and reports its dTag', () => {
    const data = createEmptyBookmarkSetData();
    addBookmarkToSetData(data, '', tag('e', 'a'), false);
    expect(isValueBookmarked(data, 'a')).toEqual({
      exists: true,
      isPrivate: false,
      dTag: '',
    });
  });

  it('finds a private bookmark', () => {
    const data = createEmptyBookmarkSetData();
    addBookmarkToSetData(data, 'Work', tag('e', 'a'), true);
    expect(isValueBookmarked(data, 'a')).toEqual({
      exists: true,
      isPrivate: true,
      dTag: 'Work',
    });
  });

  it('returns exists:false for unknown values', () => {
    const data = createEmptyBookmarkSetData();
    expect(isValueBookmarked(data, 'nope')).toEqual({
      exists: false,
      isPrivate: false,
      dTag: '',
    });
  });
});

describe('addBookmarkToSetData', () => {
  it('adds a public tag to the root set', () => {
    const data = createEmptyBookmarkSetData();
    addBookmarkToSetData(data, '', tag('e', 'a'), false);
    expect(rootSetOf(data).publicTags).toEqual([tag('e', 'a')]);
  });

  it('adds a private tag to the private array', () => {
    const data = createEmptyBookmarkSetData();
    addBookmarkToSetData(data, '', tag('e', 'a'), true);
    expect(rootSetOf(data).privateTags).toEqual([tag('e', 'a')]);
    expect(rootSetOf(data).publicTags).toEqual([]);
  });

  it('creates the target set when it does not exist yet', () => {
    const data = createEmptyBookmarkSetData();
    addBookmarkToSetData(data, 'New', tag('e', 'a'), false);
    expect(data.sets.map(s => s.d)).toContain('New');
    expect(data.metadata.setOrder).toContain('New');
  });

  it('does not add the same type+value twice', () => {
    const data = createEmptyBookmarkSetData();
    addBookmarkToSetData(data, '', tag('e', 'a'), false);
    const before = data.metadata.lastModified;
    addBookmarkToSetData(data, '', tag('e', 'a'), false);
    expect(rootSetOf(data).publicTags).toHaveLength(1);
    expect(data.metadata.lastModified).toBe(before);
  });
});

describe('removeBookmarkFromSetData', () => {
  it('removes the value from public and private arrays of every set', () => {
    const data = createEmptyBookmarkSetData();
    addBookmarkToSetData(data, '', tag('e', 'a'), false);
    addBookmarkToSetData(data, 'Work', tag('e', 'a'), true);
    removeBookmarkFromSetData(data, 'a');
    expect(rootSetOf(data).publicTags).toEqual([]);
    expect(data.sets.find(s => s.d === 'Work')!.privateTags).toEqual([]);
  });

  it('leaves other values untouched', () => {
    const data = createEmptyBookmarkSetData();
    addBookmarkToSetData(data, '', tag('e', 'a'), false);
    addBookmarkToSetData(data, '', tag('e', 'b'), false);
    removeBookmarkFromSetData(data, 'a');
    expect(rootSetOf(data).publicTags.map(t => t.value)).toEqual(['b']);
  });
});

describe('moveBookmarkInSetData', () => {
  it('moves a public bookmark to the target set, keeping privacy', () => {
    const data = createEmptyBookmarkSetData();
    addBookmarkToSetData(data, '', tag('e', 'a'), false);
    addBookmarkToSetData(data, '', tag('e', 'p'), true);
    moveBookmarkInSetData(data, 'a', 'Work');
    moveBookmarkInSetData(data, 'p', 'Work');
    const work = data.sets.find(s => s.d === 'Work')!;
    expect(work.publicTags.map(t => t.value)).toEqual(['a']);
    expect(work.privateTags.map(t => t.value)).toEqual(['p']);
    expect(rootSetOf(data).publicTags).toEqual([]);
  });

  it('is a no-op for a value that does not exist', () => {
    const data = createEmptyBookmarkSetData();
    moveBookmarkInSetData(data, 'ghost', 'Work');
    expect(data.sets).toHaveLength(1);
  });
});

describe('createSetInData', () => {
  it('creates a folder set and registers it in setOrder', () => {
    const data = createEmptyBookmarkSetData();
    createSetInData(data, 'Work');
    expect(data.sets.map(s => s.d)).toEqual(['', 'Work']);
    expect(data.metadata.setOrder).toEqual(['', 'Work']);
  });

  it('is a no-op when the set already exists', () => {
    const data = createEmptyBookmarkSetData();
    createSetInData(data, 'Work');
    createSetInData(data, 'Work');
    expect(data.sets.filter(s => s.d === 'Work')).toHaveLength(1);
  });
});

describe('deleteSetFromData', () => {
  it('moves all items of the folder back to root (spec: folder delete → root)', () => {
    const data = createEmptyBookmarkSetData();
    addBookmarkToSetData(data, 'Work', tag('e', 'a'), false);
    addBookmarkToSetData(data, 'Work', tag('e', 'p'), true);
    deleteSetFromData(data, 'Work');
    expect(data.sets.map(s => s.d)).toEqual(['']);
    expect(rootSetOf(data).publicTags.map(t => t.value)).toEqual(['a']);
    expect(rootSetOf(data).privateTags.map(t => t.value)).toEqual(['p']);
    expect(data.metadata.setOrder).toEqual(['']);
  });

  it('never deletes the root set itself', () => {
    const data = createEmptyBookmarkSetData();
    deleteSetFromData(data, '');
    expect(data.sets).toHaveLength(1);
  });

  it('is a no-op for an unknown set', () => {
    const data = createEmptyBookmarkSetData();
    deleteSetFromData(data, 'Ghost');
    expect(data.sets).toHaveLength(1);
  });
});

describe('extractItemsFromSetData', () => {
  it('flattens all sets into items with category and privacy metadata', () => {
    const data = createEmptyBookmarkSetData();
    addBookmarkToSetData(
      data,
      '',
      { type: 'e', value: 'a', description: 'd1' },
      false
    );
    addBookmarkToSetData(data, 'Work', { type: 'r', value: 'https://x' }, true);
    const items = extractItemsFromSetData(data);
    expect(items).toHaveLength(2);
    const rootItem = items.find(i => i.value === 'a')!;
    expect(rootItem).toMatchObject({
      id: 'a',
      type: 'e',
      isPrivate: false,
      category: '',
      description: 'd1',
    });
    const workItem = items.find(i => i.value === 'https://x')!;
    expect(workItem).toMatchObject({
      id: 'https://x',
      type: 'r',
      isPrivate: true,
      category: 'Work',
    });
  });
});

describe('extractFolderDataFromSetData', () => {
  it('derives folders, assignments and rootOrder from set data', () => {
    const data = createEmptyBookmarkSetData();
    addBookmarkToSetData(data, 'Work', tag('e', 'a'), false);
    addBookmarkToSetData(data, 'Work', tag('e', 'b'), true);
    addBookmarkToSetData(data, '', tag('e', 'c'), false);

    const { folders, folderAssignments, rootOrder } =
      extractFolderDataFromSetData(data);

    expect(folders).toEqual([
      {
        id: 'folder_Work',
        name: 'Work',
        createdAt: data.metadata.lastModified,
      },
    ]);
    const workAssignments = folderAssignments.filter(
      a => a.folderId === 'folder_Work'
    );
    expect(workAssignments.map(a => a.bookmarkId)).toEqual(['a', 'b']);
    expect(workAssignments.map(a => a.order)).toEqual([0, 1]);
    const rootAssignments = folderAssignments.filter(a => a.folderId === '');
    expect(rootAssignments.map(a => a.bookmarkId)).toEqual(['c']);
    expect(rootOrder).toEqual([
      { type: 'folder', id: 'folder_Work' },
      { type: 'bookmark', id: 'c' },
    ]);
  });

  it('returns empty structures for empty data', () => {
    const { folders, folderAssignments, rootOrder } =
      extractFolderDataFromSetData(createEmptyBookmarkSetData());
    expect(folders).toEqual([]);
    expect(folderAssignments).toEqual([]);
    expect(rootOrder).toEqual([]);
  });
});
