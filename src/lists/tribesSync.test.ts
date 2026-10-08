/* eslint-disable camelcase -- Nostr protocol event fields are snake_case by spec */
/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

const TEST_PK = 'aa'.repeat(32);
const NOW = 1_800_000_000;

const cryptoStore = vi.hoisted(() => ({
  plaintexts: new Map<string, string>(),
}));

const relay = vi.hoisted(() => ({
  setEvents: [] as unknown[], // kind:30000
  deletionEvents: [] as unknown[], // kind:5
  orderEvents: [] as unknown[], // kind:30078 (tribe folders order)
  deletionRecord: [] as unknown[], // kind:30078 (noornote:tribe-deletions)
  published: [] as Array<{ kind: number; tags: string[][]; content: string }>,
  writeRelays: ['wss://relay'],
}));

function resetRelay(): void {
  relay.setEvents = [];
  relay.deletionEvents = [];
  relay.orderEvents = [];
  relay.deletionRecord = [];
  relay.published = [];
  relay.writeRelays = ['wss://relay'];
  cryptoStore.plaintexts.clear();
}

vi.mock('./relays', () => ({
  getTransport: () => ({}),
  getReadRelays: () => [],
  getWriteRelays: () => relay.writeRelays,
  getCurrentUserPubkey: () => 'aa'.repeat(32),
  requireAuth: () => ({ pubkey: 'aa'.repeat(32) }),
  fetchEvents: async (
    filters: Array<{ kinds?: number[]; '#d'?: string[] }>
  ): Promise<unknown[]> => {
    if (relay.failFetch) throw new Error('relay down');
    const f = filters[0] ?? {};
    const dTags = f['#d'] ?? [];
    if (dTags.includes('noornote:tribe-deletions')) return relay.deletionRecord;
    if (dTags.includes('noornote:tribe-folders-order'))
      return relay.orderEvents;
    const kind = f.kinds?.[0];
    if (kind === 5) return relay.deletionEvents;
    if (kind === 30000) return relay.setEvents;
    return [];
  },
  publishEvent: async (event: {
    kind: number;
    tags: string[][];
    content: string;
  }) => {
    relay.published.push(event);
    return new Set(['wss://relay']);
  },
  signEvent: async (event: {
    kind: number;
    tags: string[][];
    content: string;
  }) => ({
    ...event,
    id: 'de'.repeat(32),
    sig: 'ff'.repeat(64),
  }),
  encryptContent: async (plaintext: string) => {
    const ct = `enc:${plaintext}`;
    cryptoStore.plaintexts.set(ct, plaintext);
    return ct;
  },
  decryptContent: async (ciphertext: string) =>
    cryptoStore.plaintexts.get(ciphertext) ?? null,
}));

vi.mock('../services/AuthService', () => ({
  AuthService: {
    getInstance: () => ({
      getCurrentUser: () => ({ pubkey: 'aa'.repeat(32) }),
    }),
  },
}));

import {
  fetchFromRelays,
  publishToRelays,
  applyRelayFetchResult,
  addNewMembersToFolders,
  mergeRelayFolderStructurePreservingBrowserOnly,
  addTribeTombstone,
  isTribeTombstoned,
  getMembers,
  setMembers,
  getFolders,
  setFolders,
  getAssignments,
  setAssignments,
  getRootOrder,
  setRootOrder,
  createFolder,
  moveMemberToFolder,
  TribeStorageAdapter,
  type TribeMember,
} from './tribes';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';

const storage = PerAccountLocalStorage.getInstance();

const M1 = '11'.repeat(32);
const M2 = '22'.repeat(32);
const M3 = '33'.repeat(32);

function member(
  pubkey: string,
  overrides: Partial<TribeMember> = {}
): TribeMember {
  return {
    id: `${pubkey}_T1`,
    pubkey,
    addedAt: NOW,
    ...overrides,
  };
}

function tribeEvent(
  tribeName: string,
  created_at: number,
  pTags: string[][],
  content = ''
): NostrEvent {
  const dTag = `tribes/${tribeName}`;
  return {
    kind: 30000,
    id: `${dTag}-${created_at}`,
    pubkey: TEST_PK,
    created_at,
    tags: [['d', dTag], ['title', tribeName], ...pTags],
    content,
    sig: 'ff'.repeat(64),
  } as unknown as NostrEvent;
}

function deletionEvent(created_at: number, coordinates: string[]): NostrEvent {
  return {
    kind: 5,
    id: `del-${created_at}-${coordinates.length}`,
    pubkey: TEST_PK,
    created_at,
    tags: coordinates.map(c => ['a', c]),
    content: '',
    sig: 'ff'.repeat(64),
  } as unknown as NostrEvent;
}

function orderEvent(created_at: number, tribeNames: string[]): NostrEvent {
  return {
    kind: 30078,
    id: `order-${created_at}`,
    pubkey: TEST_PK,
    created_at,
    tags: [
      ['d', 'noornote:tribe-folders-order'],
      ...tribeNames.map(n => ['a', `30000:${TEST_PK}:tribes/${n}`]),
    ],
    content: '',
    sig: 'ff'.repeat(64),
  } as unknown as NostrEvent;
}

function deletionRecordEvent(
  created_at: number,
  entries: Record<string, { t: number; d: boolean }>
): NostrEvent {
  return {
    kind: 30078,
    id: `delrec-${created_at}`,
    pubkey: TEST_PK,
    created_at,
    tags: [['d', 'noornote:tribe-deletions']],
    content: JSON.stringify({ v: 1, entries }),
    sig: 'ff'.repeat(64),
  } as unknown as NostrEvent;
}

/** Seed: one tribe T1 with the given members. */
function seedTribe(members: TribeMember[], tribeName = 'T1'): void {
  const folderId = `folder_${tribeName}`;
  setMembers(
    members.map(m => ({
      ...m,
      category: tribeName,
      id: `${m.pubkey}_${tribeName}`,
    }))
  );
  setFolders([{ id: folderId, name: tribeName, createdAt: NOW * 1000 }]);
  setAssignments(
    members.map((m, i) => ({
      memberId: `${m.pubkey}_${tribeName}`,
      folderId,
      order: i,
    }))
  );
  setRootOrder([{ type: 'folder', id: folderId }]);
}

function publishedDTags(kind: number): string[] {
  return relay.published
    .filter(p => p.kind === kind)
    .map(p => p.tags.find(t => t[0] === 'd')?.[1] ?? '');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW * 1000));
  localStorage.clear();
  resetRelay();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

// ===========================================================================
// fetchFromRelays — receiver-side filters
// ===========================================================================

describe('tribes fetchFromRelays', () => {
  it('applies the tribes/ namespace gate: foreign kind:30000 d-tags are ignored', async () => {
    relay.setEvents = [
      tribeEvent('T1', NOW, [['p', M1, '']]),
      {
        kind: 30000,
        id: 'foreign',
        pubkey: TEST_PK,
        created_at: NOW,
        tags: [
          ['d', 'private-follows'],
          ['p', M2, ''],
        ],
        content: '',
        sig: 'ff'.repeat(64),
      } as unknown as NostrEvent,
    ];
    const result = await fetchFromRelays();
    expect(result.items.map(i => i.pubkey)).toEqual([M1]);
    expect(result.categories).toEqual(['tribes/', 'tribes/T1']);
  });

  it('suppresses tombstoned tribes regardless of created_at (bare name, no prefix)', async () => {
    addTribeTombstone('T1');
    relay.setEvents = [tribeEvent('T1', NOW, [['p', M1, '']])];
    const result = await fetchFromRelays();
    expect(result.items).toEqual([]);
    expect(result.relayContentWasEmpty).toBe(true);
    expect(isTribeTombstoned('T1')).toBe(true);
  });

  it('filters events older than the NIP-09 deletion timestamp', async () => {
    relay.setEvents = [
      tribeEvent('T1', NOW - 200, [['p', M1, '']]), // older → gone
      tribeEvent('T2', NOW, [['p', M2, '']]),
    ];
    relay.deletionEvents = [
      deletionEvent(NOW - 100, [`30000:${TEST_PK}:tribes/T1`]),
    ];
    const result = await fetchFromRelays();
    expect(result.categories).toEqual(['tribes/', 'tribes/T2']);
  });

  it('dedupes by d-tag keeping the newest event per tribe', async () => {
    relay.setEvents = [
      tribeEvent('T1', NOW - 100, [['p', M1, '']]),
      tribeEvent('T1', NOW, [['p', M2, '']]),
    ];
    const result = await fetchFromRelays();
    expect(result.items.map(i => i.pubkey)).toEqual([M2]);
  });

  it('deduplicates by pubkey across tribes — last category wins (documents flattening)', async () => {
    relay.setEvents = [
      tribeEvent('A', NOW, [['p', M1, '']]),
      tribeEvent('B', NOW, [['p', M1, '']]),
    ];
    const result = await fetchFromRelays();
    // KNOWN BEHAVIOR: a member in two tribes collapses to one item.
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.category).toBe('B');
  });

  it('decrypts private members into isPrivate=true items of the same tribe', async () => {
    const privateTags = JSON.stringify([['p', M2, '']]);
    const ct = `enc:${privateTags}`;
    cryptoStore.plaintexts.set(ct, privateTags);
    relay.setEvents = [tribeEvent('T1', NOW, [['p', M1, '']], ct)];
    const result = await fetchFromRelays();
    const priv = result.items.find(i => i.pubkey === M2);
    expect(priv?.isPrivate).toBe(true);
    expect(priv?.category).toBe('T1');
    expect(result.items.find(i => i.pubkey === M1)?.isPrivate).toBe(false);
  });

  it('reads the folder order from kind:30078 tags (content is empty — documents the difference to bookmarks)', async () => {
    relay.setEvents = [
      tribeEvent('AI', NOW, [['p', M1, '']]),
      tribeEvent('Work', NOW, [['p', M2, '']]),
      tribeEvent('Zzz', NOW, [['p', M3, '']]),
    ];
    relay.orderEvents = [orderEvent(NOW, ['Work', 'AI'])]; // Zzz not listed
    const result = await fetchFromRelays();
    expect(result.categories).toEqual([
      'tribes/',
      'tribes/Work',
      'tribes/AI',
      'tribes/Zzz',
    ]);
  });

  it('falls back to alphabetical order when no order event exists', async () => {
    relay.setEvents = [
      tribeEvent('Work', NOW, [['p', M2, '']]),
      tribeEvent('AI', NOW, [['p', M1, '']]),
    ];
    const result = await fetchFromRelays();
    expect(result.categories).toEqual(['tribes/', 'tribes/AI', 'tribes/Work']);
  });

  it('reports relayContentWasEmpty when nothing survives the filters', async () => {
    const result = await fetchFromRelays();
    expect(result.items).toEqual([]);
    expect(result.relayContentWasEmpty).toBe(true);
    expect(result.relayTimestamp).toBe(0);
  });

  it('pulls the shared deletion record into local tombstones before filtering', async () => {
    relay.deletionRecord = [
      deletionRecordEvent(NOW - 10, { Gone: { t: NOW - 10, d: true } }),
    ];
    relay.setEvents = [tribeEvent('Gone', NOW, [['p', M1, '']])];
    const result = await fetchFromRelays();
    expect(result.items).toEqual([]);
    expect(isTribeTombstoned('Gone')).toBe(true);
  });
});

// ===========================================================================
// publishToRelays — sender-side filters
// ===========================================================================

describe('tribes publishToRelays', () => {
  it('prefixes d-tags with tribes/ and always publishes the root set', async () => {
    seedTribe([member(M1)]);
    await publishToRelays();
    expect(publishedDTags(30000)).toEqual(['tribes/', 'tribes/T1']);
  });

  it('does NOT publish orphaned members (no folder assignment) or root members', async () => {
    seedTribe([member(M1)]);
    // M2 has no assignment (orphan), M3 sits in root.
    setMembers([
      member(M1, { category: 'T1', id: `${M1}_T1` }),
      member(M2, { category: 'T1', id: `${M2}_T1` }), // orphan
      member(M3, { category: '', id: M3 }), // root
    ]);
    await publishToRelays();
    const t1Event = relay.published.find(
      p => p.kind === 30000 && p.tags.some(t => t[1] === 'tribes/T1')
    );
    const pTags = (t1Event?.tags ?? []).filter(t => t[0] === 'p');
    expect(pTags.map(t => t[1])).toEqual([M1]);
  });

  it('never publishes a tombstoned tribe and excludes it from the order event', async () => {
    seedTribe([member(M1)]);
    createFolder('T2');
    moveMemberToFolder(`${M1}_T1`, 'folder_T1'); // no-op, keeps state consistent
    addTribeTombstone('T2');
    await publishToRelays();
    expect(publishedDTags(30000)).not.toContain('tribes/T2');
    const orderEvent = relay.published.find(
      p =>
        p.kind === 30078 &&
        p.tags.some(t => t[1] === 'noornote:tribe-folders-order')
    );
    const aTags = (orderEvent?.tags ?? []).filter(t => t[0] === 'a');
    expect(aTags.map(t => t[1])).not.toContain(`30000:${TEST_PK}:tribes/T2`);
  });

  it('skips empty non-root sets', async () => {
    seedTribe([member(M1)]);
    createFolder('Empty'); // no members
    await publishToRelays();
    expect(publishedDTags(30000)).toEqual(['tribes/', 'tribes/T1']);
  });

  it('publishes public members as p-tags with relay slot and private members encrypted', async () => {
    seedTribe([
      member(M1, { relay: 'wss://outbox' }),
      member(M2, { isPrivate: true }),
    ]);
    await publishToRelays();
    const t1Event = relay.published.find(
      p => p.kind === 30000 && p.tags.some(t => t[1] === 'tribes/T1')
    );
    expect(t1Event).toBeDefined();
    const pubTag = t1Event!.tags.find(t => t[0] === 'p' && t[1] === M1);
    expect(pubTag).toEqual(['p', M1, 'wss://outbox']);
    expect(t1Event!.tags.some(t => t[1] === M2)).toBe(false);
    const plaintext = cryptoStore.plaintexts.get(t1Event!.content);
    expect(JSON.parse(plaintext!)).toEqual([['p', M2, '']]);
  });

  it('adds the client tag only when opted in', async () => {
    seedTribe([member(M1)]);
    await publishToRelays();
    const without = relay.published.find(p => p.kind === 30000);
    expect((without?.tags ?? []).some(t => t[0] === 'client')).toBe(false);

    storage.set(StorageKeys.CLIENT_TAG_ENABLED, true);
    relay.published = [];
    await publishToRelays();
    const withTag = relay.published.find(p => p.kind === 30000);
    expect(withTag?.tags ?? []).toContainEqual(['client', 'NoorNote']);
  });

  it('publishes the folder order as kind:30078 with a-tag coordinates and empty content', async () => {
    seedTribe([member(M1)]);
    createFolder('Second');
    setRootOrder([
      { type: 'folder', id: 'folder_Second' },
      { type: 'folder', id: 'folder_T1' },
    ]);
    await publishToRelays();
    const orderEvents = relay.published.filter(p => p.kind === 30078);
    expect(orderEvents).toHaveLength(1);
    expect(orderEvents[0]!.content).toBe('');
    const aTags = orderEvents[0]!.tags.filter(t => t[0] === 'a');
    expect(aTags.map(t => t[1])).toEqual([
      `30000:${TEST_PK}:tribes/Second`,
      `30000:${TEST_PK}:tribes/T1`,
    ]);
  });
});

// ===========================================================================
// Apply strategies
// ===========================================================================

describe('tribes apply strategies', () => {
  it('applyRelayFetchResult rebuilds folders from categories and drops members without a folder', () => {
    const relayItems = [
      member(M1, { category: 'AI', id: `${M1}_AI` }),
      member(M2, { category: '', id: M2 }), // no root in tribes
    ];
    applyRelayFetchResult(relayItems, undefined, ['tribes/', 'tribes/AI']);
    expect(getFolders().map(f => f.id)).toEqual(['folder_AI']);
    expect(getAssignments().map(a => a.memberId)).toEqual([`${M1}_AI`]);
    // M2 is NOT added to root (tribes invariant).
    expect(getRootOrder().some(r => r.type !== 'folder')).toBe(false);
  });

  it('applyRelayFetchResult never re-creates a tombstoned tribe', () => {
    addTribeTombstone('AI');
    applyRelayFetchResult(
      [member(M1, { category: 'AI', id: `${M1}_AI` })],
      undefined,
      ['tribes/', 'tribes/AI']
    );
    expect(getFolders()).toEqual([]);
  });

  it('addNewMembersToFolders wires assignments for existing members only; tombstoned tribes are skipped entirely', () => {
    seedTribe([member(M1)]);
    // M2 exists but has no assignment yet — the helper only wires assignments,
    // it does NOT create member objects (unlike the bookmarks analog).
    setMembers([
      ...getMembers(),
      member(M2, { category: 'T1', id: `${M2}_T1` }),
    ]);
    addTribeTombstone('Dead');
    addNewMembersToFolders([
      member(M2, { category: 'T1', id: `${M2}_T1` }),
      member(M3, { category: 'Dead', id: `${M3}_Dead` }),
    ]);
    expect(getFolders().map(f => f.name)).toEqual(['T1']); // no Dead folder
    const assigned = getAssignments().map(a => a.memberId);
    expect(assigned).toContain(`${M2}_T1`);
    expect(assigned).not.toContain(`${M3}_Dead`); // tombstoned → dropped, no root fallback
  });

  it('mergeRelayFolderStructurePreservingBrowserOnly preserves browser-only tribes', () => {
    seedTribe([member(M1)]);
    createFolder('Mine');
    setMembers([
      member(M1, { category: 'T1', id: `${M1}_T1` }),
      member(M2, { category: 'Mine', id: `${M2}_Mine` }),
    ]);
    setAssignments([
      { memberId: `${M1}_T1`, folderId: 'folder_T1', order: 0 },
      { memberId: `${M2}_Mine`, folderId: 'folder_Mine', order: 0 },
    ]);
    setRootOrder([
      { type: 'folder', id: 'folder_T1' },
      { type: 'folder', id: 'folder_Mine' },
    ]);
    // Relay only knows T1 + M1.
    mergeRelayFolderStructurePreservingBrowserOnly(
      [member(M1, { category: 'T1', id: `${M1}_T1` })],
      ['tribes/', 'tribes/T1'],
      [member(M2, { category: 'Mine', id: `${M2}_Mine` })]
    );
    expect(
      getFolders()
        .map(f => f.name)
        .sort()
    ).toEqual(['Mine', 'T1']);
    expect(getMembersInFolderNames()).toEqual({ T1: [M1], Mine: [M2] });
  });

  // Local helper — resolves member pubkeys per folder name via exported getters.
  function getMembersInFolderNames(): Record<string, string[]> {
    const assignments = getAssignments();
    const out: Record<string, string[]> = {};
    for (const folder of getFolders()) {
      out[folder.name] = assignments
        .filter(a => a.folderId === folder.id)
        .sort((a, b) => a.order - b.order)
        .map(a => getMembers().find(m => m.id === a.memberId)?.pubkey ?? '');
    }
    return out;
  }
});

// ===========================================================================
// TribeStorageAdapter
// ===========================================================================

describe('TribeStorageAdapter.syncFromRelays', () => {
  const adapter = new TribeStorageAdapter();

  it('identical state → requiresConfirmation=false', async () => {
    seedTribe([member(M1)]);
    relay.setEvents = [tribeEvent('T1', NOW, [['p', M1, '']])];
    const result = await adapter.syncFromRelays();
    expect(result.requiresConfirmation).toBe(false);
    expect(result.diff.added).toHaveLength(0);
    expect(result.diff.removed).toHaveLength(0);
  });

  it('detects added/removed members by pubkey', async () => {
    seedTribe([member(M1)]);
    relay.setEvents = [tribeEvent('T1', NOW, [['p', M2, '']])];
    const result = await adapter.syncFromRelays();
    expect(result.diff.added.map(i => i.pubkey)).toEqual([M2]);
    expect(result.diff.removed.map(i => i.pubkey)).toEqual([M1]);
    expect(result.requiresConfirmation).toBe(true);
  });

  it('applySyncFromRelays overwrite replaces members; merge keeps browser on pubkey conflict', () => {
    seedTribe([member(M1)]);
    adapter.applySyncFromRelays('overwrite', [
      member(M2, { category: 'T1', id: `${M2}_T1` }),
    ]);
    expect(getMembers().map(m => m.pubkey)).toEqual([M2]);

    setMembers([member(M1, { category: 'T1', id: `${M1}_T1` })]);
    adapter.applySyncFromRelays('merge', [
      member(M1, { category: 'T1', id: `${M1}_T1`, addedAt: NOW + 5 }),
      member(M3, { category: 'T1', id: `${M3}_T1` }),
    ]);
    const m1 = getMembers().find(m => m.pubkey === M1);
    expect(m1?.addedAt).toBe(NOW); // browser item kept
    expect(
      getMembers()
        .map(m => m.pubkey)
        .sort()
    ).toEqual([M1, M3].sort());
  });
});
