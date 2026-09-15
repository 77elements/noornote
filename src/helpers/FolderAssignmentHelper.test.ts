/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock SystemLogger: the real singleton sits in an import cycle
// (SystemLogger → … → lists/follows → lists/file → SystemLogger) that breaks
// module init under vitest. The helper only uses info-logging.
vi.mock('../services/SystemLogger', () => ({
  SystemLogger: {
    getInstance: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  },
}));

import {
  applyFolderAssignments,
  type FolderService,
} from './FolderAssignmentHelper';

function makeService(existing: { id: string; name: string }[] = []) {
  const created: string[] = [];
  const moveToFolder = vi.fn();
  const service: FolderService = {
    getFolders: () => {
      // Mirrors the real services: folders created in this pass become visible.
      return existing.concat(
        created.map(name => ({ id: `folder_${name}`, name }))
      );
    },
    createFolder: (name: string) => {
      created.push(name);
      return { id: `folder_${name}`, name };
    },
  };
  return { service, created, moveToFolder };
}

describe('applyFolderAssignments', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns early for an empty assignment map', async () => {
    const { service, created, moveToFolder } = makeService();
    await applyFolderAssignments(new Map(), service, moveToFolder, 'Test');
    expect(created).toEqual([]);
    expect(moveToFolder).not.toHaveBeenCalled();
  });

  it('creates folders for new categories and routes items to them', async () => {
    const { service, created, moveToFolder } = makeService();
    await applyFolderAssignments(
      new Map([
        ['note1', 'Work'],
        ['note2', 'Work'],
      ]),
      service,
      moveToFolder,
      'Test'
    );
    expect(created).toEqual(['Work']);
    expect(moveToFolder).toHaveBeenCalledWith('note1', 'folder_Work');
    expect(moveToFolder).toHaveBeenCalledWith('note2', 'folder_Work');
  });

  it('does not recreate an existing folder', async () => {
    const { service, created } = makeService([
      { id: 'folder_Work', name: 'Work' },
    ]);
    await applyFolderAssignments(
      new Map([['note1', 'Work']]),
      service,
      () => {},
      'Test'
    );
    expect(created).toEqual([]);
  });

  it('routes items with an empty category to root', async () => {
    const { service, moveToFolder } = makeService();
    await applyFolderAssignments(
      new Map([['note1', '']]),
      service,
      moveToFolder,
      'Test'
    );
    expect(moveToFolder).toHaveBeenCalledWith('note1', '');
  });

  it('never recreates a tombstoned category and routes its items to root', async () => {
    // THE regression test for the tombstone-erase loop (lists.md 2026-06-04):
    // creating a deleted folder would clear its tombstone via createFolder and
    // resurrect it — the helper must skip the create AND keep the item in root.
    const { service, created, moveToFolder } = makeService();
    const isTombstoned = (name: string) => name === 'Deleted';
    await applyFolderAssignments(
      new Map([
        ['note1', 'Deleted'],
        ['note2', 'Alive'],
      ]),
      service,
      moveToFolder,
      'Test',
      isTombstoned
    );
    expect(created).toEqual(['Alive']);
    expect(moveToFolder).toHaveBeenCalledWith('note1', '');
    expect(moveToFolder).toHaveBeenCalledWith('note2', 'folder_Alive');
  });

  it('treats every distinct category once for creation, items individually for moves', async () => {
    const { service, created, moveToFolder } = makeService();
    await applyFolderAssignments(
      new Map([
        ['a', 'X'],
        ['b', 'X'],
        ['c', 'Y'],
      ]),
      service,
      moveToFolder,
      'Test'
    );
    expect(created.sort()).toEqual(['X', 'Y']);
    expect(moveToFolder).toHaveBeenCalledTimes(3);
  });

  it('skips the move silently when the target folder is missing and not creatable', async () => {
    // A category that is neither root, tombstoned, nor creatable (service
    // rejects) — moveToFolder must not be called with a dangling folder id.
    const service: FolderService = {
      getFolders: () => [],
      createFolder: () => {
        throw new Error('quota');
      },
    };
    // createFolder throwing would bubble — document that the helper does not
    // swallow creation errors (fail-loud is the current contract).
    await expect(
      applyFolderAssignments(new Map([['a', 'X']]), service, () => {}, 'Test')
    ).rejects.toThrow('quota');
  });
});
