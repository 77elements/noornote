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
  getMembers,
  setMembers,
  getMember,
  getFolders,
  getAssignments,
  setAssignments,
  getMemberFolder,
  getMembersInFolder,
  getFolderItemCount,
  getFolderByName,
  getRootOrder,
  hasRootOrder,
  clearRootOrder,
  createFolder,
  renameFolder,
  deleteFolder,
  addMember,
  removeMember,
  ensureMemberAssignment,
  removeMemberAssignment,
  removeMemberAssignmentsByPubkey,
  moveMemberToFolder,
  moveItemToPosition,
  addToRootOrder,
  removeFromRootOrder,
  moveInRootOrder,
  extractPubkeyFromMemberId,
  getMemberPubkeysInFolder,
  getFoldersInRootOrder,
  isPrivateTribesEnabled,
  setPrivateTribesEnabled,
  isTribeTombstoned,
  addTribeTombstone,
  removeTribeTombstone,
} from './tribes';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';

const PK1 = '11'.repeat(32);
const PK2 = '22'.repeat(32);

function resetTribeState(): void {
  const storage = PerAccountLocalStorage.getInstance();
  storage.remove(StorageKeys.TRIBES);
  storage.remove(StorageKeys.TRIBE_FOLDERS);
  storage.remove(StorageKeys.TRIBE_MEMBER_ASSIGNMENTS);
  storage.remove(StorageKeys.TRIBE_ROOT_ORDER);
  storage.remove(StorageKeys.TRIBE_TOMBSTONES);
  storage.remove(StorageKeys.PRIVATE_TRIBES_ENABLED);
}

describe('tribes folder CRUD', () => {
  beforeEach(resetTribeState);

  it('createFolder uses the deterministic folder_<name> id', () => {
    const folder = createFolder('Friends');
    expect(folder).toMatchObject({ id: 'folder_Friends', name: 'Friends' });
    expect(getFolders()).toEqual([folder]);
  });

  it('createFolder registers the folder in the root order', () => {
    const folder = createFolder('Friends');
    expect(getRootOrder()).toContainEqual({ type: 'folder', id: folder.id });
  });

  it('createFolder clears an existing tombstone (explicit re-creation)', () => {
    addTribeTombstone('Friends');
    expect(isTribeTombstoned('Friends')).toBe(true);
    createFolder('Friends');
    expect(isTribeTombstoned('Friends')).toBe(false);
  });

  it('renameFolder renames the folder in place', () => {
    const folder = createFolder('Old');
    renameFolder(folder.id, 'New');
    expect(getFolderByName('Old')).toBeUndefined();
    expect(getFolderByName('New')).toBeDefined();
  });

  it('renameFolder is a no-op for an unknown folder id', () => {
    createFolder('Real');
    renameFolder('folder_Ghost', 'X');
    expect(getFolderByName('Real')).toBeDefined();
    expect(getFolderByName('X')).toBeUndefined();
  });

  it('deleteFolder cascades: assignments, folder and root-order entries are removed', () => {
    createFolder('Tribe');
    addMember(PK1, false, 'Tribe');
    addMember(PK2, false, 'Tribe');
    const removed = deleteFolder('folder_Tribe');
    expect(removed.sort()).toEqual([`${PK1}_Tribe`, `${PK2}_Tribe`].sort());
    expect(getFolders()).toEqual([]);
    expect(getAssignments()).toEqual([]);
    expect(getRootOrder()).toEqual([]);
    // Members themselves are removed at manager level (deleteFolderUI);
    // the low-level folder delete only detaches assignments.
    expect(getMembers()).toHaveLength(2);
  });

  it('deleteFolder returns an empty array for an unknown folder', () => {
    expect(deleteFolder('folder_Ghost')).toEqual([]);
  });
});

describe('tribes member CRUD', () => {
  beforeEach(resetTribeState);

  it('addMember creates a member with the composite pubkey_category id', () => {
    createFolder('Tribe');
    addMember(PK1, false, 'Tribe');
    const member = getMember(PK1)!;
    expect(member).toBeDefined();
    expect(member.id).toBe(`${PK1}_Tribe`);
    expect(member.isPrivate).toBe(false);
    expect(member.category).toBe('Tribe');
    expect(typeof member.addedAt).toBe('number');
  });

  it('addMember throws without a category (no root members in tribes)', () => {
    expect(() => addMember(PK1, false, '')).toThrow();
  });

  it('addMember is idempotent for the same pubkey+category', () => {
    createFolder('Tribe');
    addMember(PK1, false, 'Tribe');
    addMember(PK1, false, 'Tribe');
    expect(getMembers()).toHaveLength(1);
  });

  it('addMember: same pubkey in a second tribe replaces the first (setMembers dedups by pubkey, last wins)', () => {
    createFolder('A');
    createFolder('B');
    addMember(PK1, false, 'A');
    addMember(PK1, false, 'B');
    expect(getMembers()).toHaveLength(1);
    expect(getMembers()[0]!.category).toBe('B');
  });

  it('addMember downgrades private to public when the feature flag is off', () => {
    createFolder('Tribe');
    addMember(PK1, true, 'Tribe');
    expect(getMember(PK1)!.isPrivate).toBe(false);
  });

  it('addMember keeps private when the feature flag is on', () => {
    setPrivateTribesEnabled(true);
    createFolder('Tribe');
    addMember(PK1, true, 'Tribe');
    expect(getMember(PK1)!.isPrivate).toBe(true);
  });

  it('addMember assigns the member to the tribe folder', () => {
    createFolder('Tribe');
    addMember(PK1, false, 'Tribe');
    expect(getMemberFolder(`${PK1}_Tribe`)).toBe('folder_Tribe');
  });

  it('removeMember removes the member and all its assignments', () => {
    createFolder('A');
    createFolder('B');
    addMember(PK1, false, 'A');
    addMember(PK1, false, 'B');
    removeMember(PK1);
    expect(getMembers()).toEqual([]);
    expect(getAssignments()).toEqual([]);
  });

  it('removeMember cleans up orphaned assignments by pubkey prefix', () => {
    setMembers([
      {
        id: `${PK1}_X`,
        pubkey: PK1,
        relay: '',
        addedAt: 1,
        isPrivate: false,
        category: 'X',
      },
    ]);
    setAssignments([{ memberId: `${PK1}_orphaned`, folderId: '', order: 0 }]);
    removeMember(PK1);
    expect(getAssignments()).toEqual([]);
  });
});

describe('tribes assignments & ordering', () => {
  beforeEach(resetTribeState);

  it('ensureMemberAssignment creates a root assignment with max+1 order', () => {
    ensureMemberAssignment('m1');
    ensureMemberAssignment('m2');
    expect(getAssignments()).toEqual([
      { memberId: 'm1', folderId: '', order: 0 },
      { memberId: 'm2', folderId: '', order: 1 },
    ]);
  });

  it('ensureMemberAssignment is a no-op when the assignment exists', () => {
    setAssignments([{ memberId: 'm1', folderId: 'folder_X', order: 5 }]);
    ensureMemberAssignment('m1');
    expect(getAssignments()).toEqual([
      { memberId: 'm1', folderId: 'folder_X', order: 5 },
    ]);
  });

  it('removeMemberAssignment removes only that member', () => {
    setAssignments([
      { memberId: 'm1', folderId: '', order: 0 },
      { memberId: 'm2', folderId: '', order: 1 },
    ]);
    removeMemberAssignment('m1');
    expect(getAssignments().map(a => a.memberId)).toEqual(['m2']);
  });

  it('removeMemberAssignmentsByPubkey removes all assignments starting with the pubkey', () => {
    setAssignments([
      { memberId: `${PK1}_A`, folderId: '', order: 0 },
      { memberId: `${PK1}_B`, folderId: '', order: 1 },
      { memberId: `${PK2}_A`, folderId: '', order: 2 },
    ]);
    removeMemberAssignmentsByPubkey(PK1);
    expect(getAssignments().map(a => a.memberId)).toEqual([`${PK2}_A`]);
  });

  it('moveMemberToFolder moves the member and appends at the end of the target', () => {
    createFolder('Target');
    ensureMemberAssignment('m1');
    moveMemberToFolder('m2', 'folder_Target');
    moveMemberToFolder('m1', 'folder_Target');
    const inFolder = getMembersInFolder('folder_Target');
    expect(inFolder).toEqual(['m2', 'm1']);
    expect(getMemberFolder('m1')).toBe('folder_Target');
  });

  it('moveMemberToFolder re-normalizes the source folder orders after a move', () => {
    setAssignments([
      { memberId: 'm1', folderId: 'folder_A', order: 0 },
      { memberId: 'm2', folderId: 'folder_A', order: 1 },
      { memberId: 'm3', folderId: 'folder_A', order: 2 },
    ]);
    createFolder('B');
    moveMemberToFolder('m2', 'folder_B');
    expect(getMembersInFolder('folder_A')).toEqual(['m1', 'm3']);
    const a0 = getAssignments().find(a => a.memberId === 'm1')!;
    const a2 = getAssignments().find(a => a.memberId === 'm3')!;
    expect([a0.order, a2.order]).toEqual([0, 1]);
  });

  it('moveItemToPosition reorders within the folder and normalizes orders', () => {
    setAssignments([
      { memberId: 'a', folderId: 'f', order: 0 },
      { memberId: 'b', folderId: 'f', order: 1 },
      { memberId: 'c', folderId: 'f', order: 2 },
    ]);
    moveItemToPosition('c', 0);
    expect(getMembersInFolder('f')).toEqual(['c', 'a', 'b']);
    expect(
      getAssignments()
        .filter(a => a.folderId === 'f')
        .map(a => a.order)
        .sort((x, y) => x - y)
    ).toEqual([0, 1, 2]);
  });

  it('moveItemToPosition clamps out-of-range indices to the end', () => {
    setAssignments([
      { memberId: 'a', folderId: 'f', order: 0 },
      { memberId: 'b', folderId: 'f', order: 1 },
    ]);
    moveItemToPosition('a', 99);
    expect(getMembersInFolder('f')).toEqual(['b', 'a']);
  });

  it('moveItemToPosition is a no-op for unknown members', () => {
    setAssignments([{ memberId: 'a', folderId: 'f', order: 0 }]);
    moveItemToPosition('ghost', 0);
    expect(getMembersInFolder('f')).toEqual(['a']);
  });

  it('getFolderItemCount counts assignments per folder', () => {
    setAssignments([
      { memberId: 'a', folderId: 'f1', order: 0 },
      { memberId: 'b', folderId: 'f1', order: 1 },
      { memberId: 'c', folderId: 'f2', order: 0 },
    ]);
    expect(getFolderItemCount('f1')).toBe(2);
    expect(getFolderItemCount('f2')).toBe(1);
    expect(getFolderItemCount('f3')).toBe(0);
  });
});

describe('tribes root order', () => {
  beforeEach(resetTribeState);

  it('addToRootOrder prepends and ignores duplicates', () => {
    addToRootOrder('folder', 'f1');
    addToRootOrder('folder', 'f2');
    addToRootOrder('folder', 'f1');
    expect(getRootOrder().map(i => i.id)).toEqual(['f2', 'f1']);
  });

  it('removeFromRootOrder removes only the matching type+id pair', () => {
    addToRootOrder('folder', 'f1');
    addToRootOrder('member', 'f1');
    removeFromRootOrder('folder', 'f1');
    expect(getRootOrder()).toEqual([{ type: 'member', id: 'f1' }]);
  });

  it('moveInRootOrder reorders entries', () => {
    addToRootOrder('folder', 'f1');
    addToRootOrder('folder', 'f2');
    addToRootOrder('folder', 'f3');
    moveInRootOrder('folder', 'f3', 0);
    expect(getRootOrder().map(i => i.id)).toEqual(['f3', 'f2', 'f1']);
  });

  it('moveInRootOrder is a no-op for unknown entries', () => {
    addToRootOrder('folder', 'f1');
    moveInRootOrder('folder', 'ghost', 0);
    expect(getRootOrder().map(i => i.id)).toEqual(['f1']);
  });

  it('hasRootOrder reflects whether an explicit order was persisted', () => {
    expect(hasRootOrder()).toBe(false);
    addToRootOrder('folder', 'f1');
    expect(hasRootOrder()).toBe(true);
    clearRootOrder();
    expect(hasRootOrder()).toBe(false);
  });

  it('getRootOrder builds an initial order (root members newest first, then folders) and persists it', () => {
    createFolder('T1');
    createFolder('T2');
    setMembers([
      {
        id: `${PK1}_T1`,
        pubkey: PK1,
        relay: '',
        addedAt: 1,
        isPrivate: false,
        category: 'T1',
      },
      {
        id: `${PK2}_T1`,
        pubkey: PK2,
        relay: '',
        addedAt: 2,
        isPrivate: false,
        category: 'T1',
      },
    ]);
    ensureMemberAssignment(`${PK1}_T1`);
    ensureMemberAssignment(`${PK2}_T1`);
    clearRootOrder();

    const order = getRootOrder();
    expect(order).toEqual([
      { type: 'member', id: `${PK2}_T1` },
      { type: 'member', id: `${PK1}_T1` },
      { type: 'folder', id: 'folder_T1' },
      { type: 'folder', id: 'folder_T2' },
    ]);
    expect(hasRootOrder()).toBe(true);
  });

  it('getFoldersInRootOrder returns folders in root-order sequence', () => {
    const f1 = createFolder('A');
    const f2 = createFolder('B');
    // addToRootOrder prepends → B is first
    expect(getFoldersInRootOrder().map(f => f.id)).toEqual([f2.id, f1.id]);
    moveInRootOrder('folder', f1.id, 0);
    expect(getFoldersInRootOrder().map(f => f.id)).toEqual([f1.id, f2.id]);
  });
});

describe('tribes utility functions', () => {
  beforeEach(resetTribeState);

  it('extractPubkeyFromMemberId handles pubkey and pubkey_category ids', () => {
    expect(extractPubkeyFromMemberId(PK1)).toBe(PK1);
    expect(extractPubkeyFromMemberId(`${PK1}_Tribe`)).toBe(PK1);
  });

  it('extractPubkeyFromMemberId keeps ids whose underscore is not at position 64', () => {
    expect(extractPubkeyFromMemberId('short_name')).toBe('short_name');
  });

  it('getMemberPubkeysInFolder extracts pure pubkeys from member ids', () => {
    createFolder('T');
    addMember(PK1, false, 'T');
    addMember(PK2, false, 'T');
    expect(getMemberPubkeysInFolder('folder_T').sort()).toEqual(
      [PK1, PK2].sort()
    );
  });

  it('private tribes flag round-trips', () => {
    expect(isPrivateTribesEnabled()).toBe(false);
    setPrivateTribesEnabled(true);
    expect(isPrivateTribesEnabled()).toBe(true);
  });
});

describe('tribes tombstones', () => {
  beforeEach(resetTribeState);

  it('addTribeTombstone marks a tribe as deleted', () => {
    addTribeTombstone('Shitposters');
    expect(isTribeTombstoned('Shitposters')).toBe(true);
  });

  it('removeTribeTombstone clears the marker', () => {
    addTribeTombstone('Shitposters');
    removeTribeTombstone('Shitposters');
    expect(isTribeTombstoned('Shitposters')).toBe(false);
  });

  it('empty names are never tombstoned', () => {
    addTribeTombstone('');
    expect(isTribeTombstoned('')).toBe(false);
  });

  it('removing a non-existent tombstone is a no-op', () => {
    expect(() => removeTribeTombstone('Ghost')).not.toThrow();
    expect(isTribeTombstoned('Ghost')).toBe(false);
  });

  it('tombstones store the deletion timestamp (seconds)', () => {
    const before = Math.floor(Date.now() / 1000);
    addTribeTombstone('X');
    const map = PerAccountLocalStorage.getInstance().get<
      Record<string, number>
    >(StorageKeys.TRIBE_TOMBSTONES, {});
    expect(map['X']).toBeGreaterThanOrEqual(before);
  });
});
