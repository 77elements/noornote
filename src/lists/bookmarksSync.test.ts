/* eslint-disable camelcase -- Nostr protocol event fields are snake_case by spec */
/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

const TEST_PK = 'aa'.repeat(32);
const NOW = 1_800_000_000; // fixed reference point (sec)

// Shared ciphertext store so decryptContent inverts encryptContent.
const cryptoStore = vi.hoisted(() => ({
  plaintexts: new Map<string, string>(),
}));

// Relay fixture buckets, routed by filter kind / #d tag.
const relay = vi.hoisted(() => ({
  setEvents: [] as unknown[], // kind:30003
  deletionEvents: [] as unknown[], // kind:5
  orderEvents: [] as unknown[], // kind:30078 (folder order)
  deletionRecord: [] as unknown[], // kind:30078 (noornote:bookmark-deletions)
  published: [] as Array<{ kind: number; tags: string[][]; content: string }>,
  failFetch: false,
  writeRelays: ['wss://relay'],
}));

function resetRelay(): void {
  relay.setEvents = [];
  relay.deletionEvents = [];
  relay.orderEvents = [];
  relay.deletionRecord = [];
  relay.published = [];
  relay.failFetch = false;
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
    if (dTags.includes('noornote:bookmark-deletions'))
      return relay.deletionRecord;
    if (dTags.includes('noornote:bookmark-folders-order'))
      return relay.orderEvents;
    const kind = f.kinds?.[0];
    if (kind === 5) return relay.deletionEvents;
    if (kind === 30003) return relay.setEvents;
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
  fetchBookmarksFromRelays,
  publishBookmarksToRelays,
  BookmarkStorageAdapter,
  applyRelayFetchResult,
  addNewBookmarksToFolders,
  mergeRelayBookmarkStructurePreservingBrowserOnly,
  applyRelayFolderOrder,
  getBookmarkFolderService,
  addBookmarkFolderTombstone,
  isBookmarkFolderTombstoned,
  readBrowserBookmarks,
  writeBrowserBookmarks,
  type BookmarkItem,
  type BookmarkFolder,
} from './bookmarks';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';

const storage = PerAccountLocalStorage.getInstance();

const ITEM1 = 'e1'.padEnd(64, '0');
const ITEM2 = 'e2'.padEnd(64, '0');
const ITEM3 = 'e3'.padEnd(64, '0');

function item(id: string, overrides: Partial<BookmarkItem> = {}): BookmarkItem {
  return { id, type: 'e', value: id, ...overrides };
}

function setEvent(
  dTag: string,
  created_at: number,
  tags: string[][],
  content = ''
): NostrEvent {
  return {
    kind: 30003,
    id: `${dTag}-${created_at}`,
    pubkey: TEST_PK,
    created_at,
    tags: [['d', dTag], ...tags],
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

function orderEvent(
  created_at: number,
  order: string[],
  content?: string
): NostrEvent {
  return {
    kind: 30078,
    id: `order-${created_at}`,
    pubkey: TEST_PK,
    created_at,
    tags: [
      ['d', 'noornote:bookmark-folders-order'],
      ...order.map(d => ['a', `30003:${TEST_PK}:${d}`]),
    ],
    content: content ?? JSON.stringify({ order }),
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
    tags: [['d', 'noornote:bookmark-deletions']],
    content: JSON.stringify({ v: 1, entries }),
    sig: 'ff'.repeat(64),
  } as unknown as NostrEvent;
}

function seedFolder(name: string, createdAtMs = NOW * 1000): BookmarkFolder {
  return { id: `folder_${name}`, name, createdAt: createdAtMs };
}

/** Seed localStorage: folders, assignments, root order, items. */
function seedBrowserState(
  folders: BookmarkFolder[],
  items: BookmarkItem[],
  assignments: Array<{ bookmarkId: string; folderId: string; order: number }>,
  rootOrder: Array<{ type: 'folder' | 'bookmark'; id: string }>
): void {
  storage.set(StorageKeys.BOOKMARK_FOLDERS, folders);
  storage.set(StorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS, assignments);
  storage.set(StorageKeys.BOOKMARK_ROOT_ORDER, rootOrder);
  writeBrowserBookmarks(items);
}

function publishedKinds(
  kind: number
): Array<{ kind: number; tags: string[][]; content: string }> {
  return relay.published.filter(p => p.kind === kind);
}

function publishedDTags(kind: number): string[] {
  return publishedKinds(kind).map(
    p => p.tags.find(t => t[0] === 'd')?.[1] ?? ''
  );
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
// fetchBookmarksFromRelays — the receiver-side filters
// ===========================================================================

describe('fetchBookmarksFromRelays', () => {
  it('dedupes by d-tag keeping the newest event', async () => {
    relay.setEvents = [
      setEvent('AI', NOW - 100, [['e', ITEM1]]),
      setEvent('AI', NOW, [['e', ITEM2]]),
    ];
    const result = await fetchBookmarksFromRelays(TEST_PK);
    expect(result.items.map(i => i.id)).toEqual([ITEM2]);
    expect(result.relayTimestamp).toBe(NOW);
  });

  it('filters events older than the NIP-09 deletion timestamp (created_at < deletion)', async () => {
    relay.setEvents = [
      setEvent('AI', NOW - 200, [['e', ITEM1]]), // older than deletion → gone
      setEvent('AI', NOW, [['e', ITEM2]]), // newer than deletion → survives
    ];
    relay.deletionEvents = [deletionEvent(NOW - 100, [`30003:${TEST_PK}:AI`])];
    const result = await fetchBookmarksFromRelays(TEST_PK);
    expect(result.items.map(i => i.id)).toEqual([ITEM2]);
  });

  it('suppresses tombstoned folders regardless of created_at (client-side tombstone)', async () => {
    addBookmarkFolderTombstone('AI');
    // Event is NEWER than any deletion — only the tombstone can stop it.
    relay.setEvents = [setEvent('AI', NOW, [['e', ITEM1]])];
    const result = await fetchBookmarksFromRelays(TEST_PK);
    expect(result.items).toEqual([]);
    expect(result.relayContentWasEmpty).toBe(true);
    expect(isBookmarkFolderTombstoned('AI')).toBe(true);
  });

  it('applies the shared NIP-78 deletion record into local tombstones before filtering', async () => {
    // Folder deleted on ANOTHER device → deletion record arrives via kind:30078.
    relay.deletionRecord = [
      deletionRecordEvent(NOW - 10, { Work: { t: NOW - 10, d: true } }),
    ];
    relay.setEvents = [setEvent('Work', NOW, [['e', ITEM1]])]; // newer than the record entry
    const result = await fetchBookmarksFromRelays(TEST_PK);
    expect(result.items).toEqual([]);
    expect(isBookmarkFolderTombstoned('Work')).toBe(true);
  });

  it('has no namespace gate: foreign kind:30003 d-tags become folders (read interop)', async () => {
    relay.setEvents = [
      setEvent('liked-albums', NOW, [['r', 'https://wavlake.com/x']]),
    ];
    const result = await fetchBookmarksFromRelays(TEST_PK);
    expect(result.categories).toContain('liked-albums');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.category).toBe('liked-albums');
  });

  it('prefers content-based folder order and appends d-tags missing from the order', async () => {
    relay.setEvents = [
      setEvent('AI', NOW, [['e', ITEM1]]),
      setEvent('Work', NOW, [['e', ITEM2]]),
      setEvent('Zzz', NOW, [['e', ITEM3]]),
    ];
    relay.orderEvents = [orderEvent(NOW, ['Work', 'AI'])]; // Zzz not listed
    const result = await fetchBookmarksFromRelays(TEST_PK);
    expect(result.categories).toEqual(['', 'Work', 'AI', 'Zzz']);
  });

  it('falls back to alphabetical order when no order event exists', async () => {
    relay.setEvents = [
      setEvent('Work', NOW, [['e', ITEM2]]),
      setEvent('AI', NOW, [['e', ITEM1]]),
    ];
    const result = await fetchBookmarksFromRelays(TEST_PK);
    expect(result.categories).toEqual(['', 'AI', 'Work']);
  });

  it('falls back to tag-based order when the order event content is not usable JSON', async () => {
    relay.setEvents = [
      setEvent('AI', NOW, [['e', ITEM1]]),
      setEvent('Work', NOW, [['e', ITEM2]]),
    ];
    relay.orderEvents = [orderEvent(NOW, ['Work', 'AI'], 'not-json')];
    const result = await fetchBookmarksFromRelays(TEST_PK);
    // Tag order is NOT guaranteed across relays — this fallback is the legacy path.
    expect(result.categories).toEqual(['', 'Work', 'AI']);
  });

  it('decrypts private tags into isPrivate=true items of the same category', async () => {
    const privateTags = JSON.stringify([['e', ITEM2, 'secret desc']]);
    const ct = `enc:${privateTags}`;
    cryptoStore.plaintexts.set(ct, privateTags);
    relay.setEvents = [setEvent('AI', NOW, [['e', ITEM1]], ct)];
    const result = await fetchBookmarksFromRelays(TEST_PK);
    const priv = result.items.find(i => i.id === ITEM2);
    expect(priv?.isPrivate).toBe(true);
    expect(priv?.category).toBe('AI');
    expect(priv?.description).toBe('secret desc');
  });

  it('keeps public items when decryption fails (private items lost, not public)', async () => {
    relay.setEvents = [
      setEvent('AI', NOW, [['e', ITEM1]], 'enc:unknown-ciphertext'),
    ];
    const result = await fetchBookmarksFromRelays(TEST_PK);
    expect(result.items.map(i => i.id)).toEqual([ITEM1]);
    expect(result.items[0]!.isPrivate).toBe(false);
  });

  it('returns relayContentWasEmpty when there are no sets and no deletions', async () => {
    const result = await fetchBookmarksFromRelays(TEST_PK);
    expect(result.items).toEqual([]);
    expect(result.relayContentWasEmpty).toBe(true);
    expect(result.relayTimestamp).toBe(0);
  });

  it('populates deletedCoordinates with the max deletion timestamp per coordinate', async () => {
    relay.deletionEvents = [
      deletionEvent(NOW - 50, [`30003:${TEST_PK}:AI`]),
      deletionEvent(NOW - 10, [`30003:${TEST_PK}:AI`]), // newer → wins
    ];
    // A surviving set is required: sets+deletions-only early-returns without the map.
    relay.setEvents = [setEvent('AI', NOW, [['e', ITEM1]])];
    const result = await fetchBookmarksFromRelays(TEST_PK);
    expect(result.deletedCoordinates?.get(`30003:${TEST_PK}:AI`)).toBe(
      NOW - 10
    );
    expect(result.items.map(i => i.id)).toEqual([ITEM1]); // newer than both deletions
  });

  it('reports relayContentWasEmpty when every set was filtered away', async () => {
    addBookmarkFolderTombstone('AI');
    relay.setEvents = [setEvent('AI', NOW, [['e', ITEM1]])];
    const result = await fetchBookmarksFromRelays(TEST_PK);
    expect(result.items).toEqual([]);
    expect(result.relayContentWasEmpty).toBe(true);
  });
});

// ===========================================================================
// publishBookmarksToRelays — the sender-side filters
// ===========================================================================

describe('publishBookmarksToRelays', () => {
  it('publishes the root set and skips empty non-root sets', async () => {
    const folder = seedFolder('AI');
    seedBrowserState(
      [folder],
      [item(ITEM1, { category: 'AI' })],
      [{ bookmarkId: ITEM1, folderId: folder.id, order: 0 }],
      [{ type: 'folder', id: folder.id }]
    );
    await publishBookmarksToRelays('test');
    // Root set has no items but MUST still publish; AI has items → publishes.
    expect(publishedDTags(30003)).toEqual(['', 'AI']);
  });

  it('never publishes a tombstoned folder and excludes it from the order event', async () => {
    const ai = seedFolder('AI');
    const work = seedFolder('Work');
    addBookmarkFolderTombstone('Work');
    seedBrowserState(
      [ai, work],
      [item(ITEM1, { category: 'AI' }), item(ITEM2, { category: 'Work' })],
      [
        { bookmarkId: ITEM1, folderId: ai.id, order: 0 },
        { bookmarkId: ITEM2, folderId: work.id, order: 0 },
      ],
      [
        { type: 'folder', id: ai.id },
        { type: 'folder', id: work.id },
      ]
    );
    await publishBookmarksToRelays('test');
    expect(publishedDTags(30003)).toEqual(['', 'AI']);
    const orderEvent = publishedKinds(30078).find(p =>
      p.tags.some(
        t => t[0] === 'd' && t[1] === 'noornote:bookmark-folders-order'
      )
    );
    const orderContent = JSON.parse(
      (orderEvent?.content as string) ?? '{}'
    ) as { order: string[] };
    expect(orderContent.order).toEqual(['AI']);
  });

  it('skips a set whose coordinate has a kind:5 newer than folder.createdAt (stale-tab protection)', async () => {
    const work = seedFolder('Work', (NOW - 60) * 1000); // created 60s ago
    seedBrowserState(
      [work],
      [item(ITEM2, { category: 'Work' })],
      [{ bookmarkId: ITEM2, folderId: work.id, order: 0 }],
      [{ type: 'folder', id: work.id }]
    );
    // Deleted elsewhere AFTER this device created the folder → stale tab.
    relay.deletionEvents = [deletionEvent(NOW - 10, [`30003:${TEST_PK}:Work`])];
    await publishBookmarksToRelays('test');
    expect(publishedDTags(30003)).toEqual(['']);
  });

  it('publishes a legit re-creation whose createdAt is newer than the kind:5', async () => {
    const work = seedFolder('Work', NOW * 1000); // re-created just now
    seedBrowserState(
      [work],
      [item(ITEM2, { category: 'Work' })],
      [{ bookmarkId: ITEM2, folderId: work.id, order: 0 }],
      [{ type: 'folder', id: work.id }]
    );
    relay.deletionEvents = [
      deletionEvent(NOW - 100, [`30003:${TEST_PK}:Work`]),
    ];
    await publishBookmarksToRelays('test');
    expect(publishedDTags(30003)).toEqual(['', 'Work']);
  });

  it('publishes the folder order as kind:30078 with content JSON {order:[...]}', async () => {
    const ai = seedFolder('AI');
    const work = seedFolder('Work');
    seedBrowserState(
      [ai, work],
      [item(ITEM1, { category: 'AI' }), item(ITEM2, { category: 'Work' })],
      [
        { bookmarkId: ITEM1, folderId: ai.id, order: 0 },
        { bookmarkId: ITEM2, folderId: work.id, order: 0 },
      ],
      [
        { type: 'folder', id: work.id },
        { type: 'folder', id: ai.id },
      ]
    );
    await publishBookmarksToRelays('test');
    const orderEvents = publishedKinds(30078);
    expect(orderEvents).toHaveLength(1);
    const parsed = JSON.parse(orderEvents[0]!.content) as { order: string[] };
    expect(parsed.order).toEqual(['Work', 'AI']); // rootOrder order, not alphabetical
    const aTags = orderEvents[0]!.tags.filter(t => t[0] === 'a');
    expect(aTags.map(t => t[1])).toEqual([
      `30003:${TEST_PK}:Work`,
      `30003:${TEST_PK}:AI`,
    ]);
  });

  it('encrypts private tags into the set event content (documents: description is dropped on publish)', async () => {
    const ai = seedFolder('AI');
    seedBrowserState(
      [ai],
      [
        item(ITEM1, { category: 'AI' }),
        item(ITEM2, { category: 'AI', isPrivate: true, description: 'sec' }),
      ],
      [
        { bookmarkId: ITEM1, folderId: ai.id, order: 0 },
        { bookmarkId: ITEM2, folderId: ai.id, order: 1 },
      ],
      [{ type: 'folder', id: ai.id }]
    );
    await publishBookmarksToRelays('test');
    const aiEvent = publishedKinds(30003).find(p =>
      p.tags.some(t => t[1] === 'AI')
    );
    expect(aiEvent).toBeDefined();
    // Public tags in plaintext tags array, private in encrypted content.
    expect(aiEvent!.tags.some(t => t[0] === 'e' && t[1] === ITEM1)).toBe(true);
    expect(aiEvent!.tags.some(t => t[1] === ITEM2)).toBe(false);
    const plaintext = cryptoStore.plaintexts.get(aiEvent!.content);
    expect(plaintext).toBeDefined();
    const tags = JSON.parse(plaintext!) as string[][];
    // KNOWN ISSUE (documented, NOT fixed during the field test): the publish
    // path maps private tags to {id,type,value} WITHOUT description, so
    // private custom-bookmark descriptions are lost on the relay round-trip
    // (the file backup keeps them — only the relay path drops the field).
    expect(tags).toEqual([['e', ITEM2]]);
  });

  it('round-trips PUBLIC custom bookmark descriptions via the 3rd tag element (profile-mount path)', async () => {
    const ai = seedFolder('AI');
    const url = 'https://example.com/project';
    seedBrowserState(
      [ai],
      [
        item(url, {
          type: 'r',
          category: 'AI',
          description: 'My portfolio piece',
        }),
      ],
      [{ bookmarkId: url, folderId: ai.id, order: 0 }],
      [{ type: 'folder', id: ai.id }]
    );

    // Publish → public tag carries [r, url, description].
    await publishBookmarksToRelays('test');
    const aiEvent = publishedKinds(30003).find(p =>
      p.tags.some(t => t[1] === 'AI')
    );
    expect(aiEvent).toBeDefined();
    expect(aiEvent!.tags).toContainEqual(['r', url, 'My portfolio piece']);
    expect(aiEvent!.content).toBe(''); // nothing private → no encrypted content

    // Fetch the published event back → description restored.
    relay.setEvents = [
      setEvent('AI', NOW + 10, [['r', url, 'My portfolio piece']]),
    ];
    relay.orderEvents = [orderEvent(NOW + 10, ['AI'])];
    const result = await fetchBookmarksFromRelays(TEST_PK);
    expect(result.items[0]).toMatchObject({
      id: url,
      type: 'r',
      value: url,
      description: 'My portfolio piece',
      category: 'AI',
    });
  });

  it('throws when there are no write relays', async () => {
    seedBrowserState([], [item(ITEM1)], [], []);
    relay.writeRelays = [];
    await expect(publishBookmarksToRelays('test')).rejects.toThrow(
      'No write relays available'
    );
    expect(relay.published).toHaveLength(0);
  });
});

// ===========================================================================
// BookmarkStorageAdapter — diff & snapshot comparison
// ===========================================================================

describe('BookmarkStorageAdapter.syncFromRelays (diff and snapshot)', () => {
  const adapter = new BookmarkStorageAdapter();

  function seedSingleFolderState(): void {
    const ai = seedFolder('AI');
    seedBrowserState(
      [ai],
      [item(ITEM1), item(ITEM2)],
      [
        { bookmarkId: ITEM1, folderId: ai.id, order: 0 },
        { bookmarkId: ITEM2, folderId: ai.id, order: 1 },
      ],
      [{ type: 'folder', id: ai.id }]
    );
  }

  function relaySingleFolderState(): void {
    relay.setEvents = [
      setEvent('AI', NOW, [
        ['e', ITEM1],
        ['e', ITEM2],
      ]),
    ];
    relay.orderEvents = [orderEvent(NOW, ['AI'])];
  }

  it('identical state → requiresConfirmation=false and empty diff', async () => {
    seedSingleFolderState();
    relaySingleFolderState();
    const result = await adapter.syncFromRelays();
    expect(result.requiresConfirmation).toBe(false);
    expect(result.diff.added).toHaveLength(0);
    expect(result.diff.removed).toHaveLength(0);
    expect(result.diff.moved).toHaveLength(0);
  });

  it('computes added/removed by item id', async () => {
    seedSingleFolderState();
    relay.setEvents = [setEvent('AI', NOW, [['e', ITEM3]])];
    relay.orderEvents = [orderEvent(NOW, ['AI'])];
    const result = await adapter.syncFromRelays();
    expect(result.diff.added.map(i => i.id)).toEqual([ITEM3]);
    expect(result.diff.removed.map(i => i.id).sort()).toEqual(
      [ITEM1, ITEM2].sort()
    );
  });

  it('detects moved items via folder assignments (not item.category)', async () => {
    const ai = seedFolder('AI');
    const work = seedFolder('Work');
    seedBrowserState(
      [ai, work],
      [item(ITEM1)],
      [{ bookmarkId: ITEM1, folderId: work.id, order: 0 }], // browser: Work
      [
        { type: 'folder', id: ai.id },
        { type: 'folder', id: work.id },
      ]
    );
    relay.setEvents = [setEvent('AI', NOW, [['e', ITEM1]])]; // relay: AI
    relay.orderEvents = [orderEvent(NOW, ['AI', 'Work'])];
    const result = await adapter.syncFromRelays();
    expect(result.diff.moved).toHaveLength(1);
    expect(result.diff.moved[0]!.sourceItem.category).toBe('AI');
    expect(result.requiresConfirmation).toBe(true);
  });

  it('classifies order-only differences as isOrderOnly without folder-set changes', async () => {
    const ai = seedFolder('AI');
    const work = seedFolder('Work');
    seedBrowserState(
      [ai, work],
      [item(ITEM1), item(ITEM2)],
      [
        { bookmarkId: ITEM1, folderId: ai.id, order: 0 },
        { bookmarkId: ITEM2, folderId: work.id, order: 0 },
      ],
      [
        { type: 'folder', id: ai.id },
        { type: 'folder', id: work.id },
      ]
    );
    relay.setEvents = [
      setEvent('AI', NOW, [['e', ITEM1]]),
      setEvent('Work', NOW, [['e', ITEM2]]),
    ];
    relay.orderEvents = [orderEvent(NOW, ['Work', 'AI'])]; // reversed folder order
    const result = await adapter.syncFromRelays();
    expect(result.snapshotDiffInfo?.isOrderOnly).toBe(true);
    expect(result.snapshotDiffInfo?.hasFolderSetDiff).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
  });

  it('flags new relay folders as folder-set differences', async () => {
    seedSingleFolderState();
    relay.setEvents = [
      setEvent('AI', NOW, [
        ['e', ITEM1],
        ['e', ITEM2],
      ]),
      setEvent('New', NOW, [['e', ITEM3]]),
    ];
    relay.orderEvents = [orderEvent(NOW, ['AI', 'New'])];
    const result = await adapter.syncFromRelays();
    expect(result.snapshotDiffInfo?.hasFolderSetDiff).toBe(true);
    expect(result.snapshotDiffInfo?.details.join('\n')).toContain('New');
  });

  it('flags privacy changes as content differences', async () => {
    seedSingleFolderState();
    // Decryptable content marks ITEM1 private on the relay side.
    const privateTags = JSON.stringify([['e', ITEM1]]);
    const ct = `enc:${privateTags}`;
    cryptoStore.plaintexts.set(ct, privateTags);
    relay.setEvents = [setEvent('AI', NOW, [['e', ITEM2]], ct)];
    relay.orderEvents = [orderEvent(NOW, ['AI'])];
    const result = await adapter.syncFromRelays();
    expect(result.requiresConfirmation).toBe(true);
    expect(result.snapshotDiffInfo?.details.join('\n')).toContain('privacy');
  });
});

// ===========================================================================
// Apply strategies (overwrite / merge / folder rebuilds)
// ===========================================================================

describe('bookmark apply strategies', () => {
  it('applySyncFromRelays overwrite replaces all browser items', () => {
    seedBrowserState([], [item(ITEM1)], [], []);
    const adapter = new BookmarkStorageAdapter();
    adapter.applySyncFromRelays('overwrite', [item(ITEM2), item(ITEM3)]);
    expect(
      readBrowserBookmarks()
        .map(i => i.id)
        .sort()
    ).toEqual([ITEM2, ITEM3].sort());
  });

  it('applySyncFromRelays merge keeps the browser item on id conflict (browser priority)', () => {
    seedBrowserState([], [item(ITEM1, { description: 'browser' })], [], []);
    const adapter = new BookmarkStorageAdapter();
    adapter.applySyncFromRelays('merge', [
      item(ITEM1, { description: 'relay' }),
      item(ITEM2),
    ]);
    const items = readBrowserBookmarks();
    expect(items).toHaveLength(2);
    expect(items.find(i => i.id === ITEM1)?.description).toBe('browser');
  });

  it('applyRelayFetchResult rebuilds folders from categories and assigns items', () => {
    const relayItems = [
      item(ITEM1, { category: 'AI' }),
      item(ITEM2, { category: '' }),
    ];
    applyRelayFetchResult(relayItems, undefined, ['', 'AI']);
    const service = getBookmarkFolderService();
    expect(service.getFolders().map(f => f.id)).toEqual(['folder_AI']);
    expect(service.getBookmarksInFolder('folder_AI')).toEqual([ITEM1]);
    expect(service.getRootOrder().map(r => `${r.type}:${r.id}`)).toEqual([
      'folder:folder_AI',
      `bookmark:${ITEM2}`,
    ]);
  });

  it('applyRelayFetchResult never re-creates a tombstoned folder and routes its items to root', () => {
    addBookmarkFolderTombstone('AI');
    const relayItems = [item(ITEM1, { category: 'AI' })];
    applyRelayFetchResult(relayItems, undefined, ['', 'AI']);
    expect(getBookmarkFolderService().getFolders()).toEqual([]);
    expect(
      getBookmarkFolderService()
        .getRootOrder()
        .map(r => r.id)
    ).toContain(ITEM1);
  });

  it('addNewBookmarksToFolders adds assignments for new items only and routes tombstoned categories to root', () => {
    const ai = seedFolder('AI');
    seedBrowserState(
      [ai],
      [item(ITEM1, { category: 'AI' })],
      [{ bookmarkId: ITEM1, folderId: ai.id, order: 0 }],
      [{ type: 'folder', id: ai.id }]
    );
    addBookmarkFolderTombstone('Dead');
    addNewBookmarksToFolders([
      item(ITEM1, { category: 'AI' }), // already assigned → untouched
      item(ITEM2, { category: 'AI' }), // new → assigned to AI
      item(ITEM3, { category: 'Dead' }), // tombstoned → root
    ]);
    const service = getBookmarkFolderService();
    expect(service.getFolders()).toHaveLength(1); // no 'Dead' folder recreated
    expect(service.getBookmarksInFolder(ai.id)).toEqual([ITEM1, ITEM2]);
    expect(
      service.getRootOrder().some(r => r.type === 'bookmark' && r.id === ITEM3)
    ).toBe(true);
  });

  it('mergeRelayBookmarkStructurePreservingBrowserOnly preserves browser-only assignments', () => {
    const ai = seedFolder('AI');
    const mine = seedFolder('Mine');
    seedBrowserState(
      [ai, mine],
      [item(ITEM1, { category: 'AI' }), item(ITEM2, { category: 'Mine' })],
      [
        { bookmarkId: ITEM1, folderId: ai.id, order: 0 },
        { bookmarkId: ITEM2, folderId: mine.id, order: 0 },
      ],
      [
        { type: 'folder', id: ai.id },
        { type: 'folder', id: mine.id },
      ]
    );
    // Relay only knows AI + ITEM1. "Mine"/ITEM2 are browser-only.
    mergeRelayBookmarkStructurePreservingBrowserOnly(
      [item(ITEM1, { category: 'AI' })],
      ['', 'AI'],
      [item(ITEM2, { category: 'Mine' })]
    );
    const service = getBookmarkFolderService();
    const folderNames = service
      .getFolders()
      .map(f => f.name)
      .sort();
    expect(folderNames).toEqual(['AI', 'Mine']);
    expect(service.getBookmarksInFolder('folder_Mine')).toEqual([ITEM2]);
  });

  it('applyRelayFolderOrder only reorders existing folders and keeps the rest', () => {
    const ai = seedFolder('AI');
    const work = seedFolder('Work');
    seedBrowserState(
      [ai, work],
      [item(ITEM1)],
      [{ bookmarkId: ITEM1, folderId: ai.id, order: 0 }],
      [
        { type: 'folder', id: ai.id },
        { type: 'folder', id: work.id },
        { type: 'bookmark', id: ITEM1 },
      ]
    );
    applyRelayFolderOrder(['Work', 'AI']);
    expect(
      getBookmarkFolderService()
        .getRootOrder()
        .map(r => r.id)
    ).toEqual(['folder_Work', 'folder_AI', ITEM1]);
  });
});
