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
  muteEvents: [] as unknown[], // kind:10000
  published: [] as Array<{ kind: number; tags: string[][]; content: string }>,
  writeRelays: ['wss://relay'],
}));

function resetRelay(): void {
  relay.muteEvents = [];
  relay.published = [];
  relay.writeRelays = ['wss://relay'];
  cryptoStore.plaintexts.clear();
}

vi.mock('./relays', async () => ({
  getTransport: () => ({}),
  getReadRelays: () => [],
  getWriteRelays: () => relay.writeRelays,
  getCurrentUserPubkey: () => 'aa'.repeat(32),
  requireAuth: () => ({ pubkey: 'aa'.repeat(32) }),
  fetchEvents: async (): Promise<unknown[]> => {
    if (relay.failFetch) throw new Error('relay down');
    return relay.muteEvents;
  },
  ...(await import('./syncRelayTestMock')).makeSyncRelayMockTail(
    relay,
    cryptoStore
  ),
}));

vi.mock('../services/AuthService', async () => {
  const { makeAuthServiceMock } = await import('./syncRelayTestMock');
  return makeAuthServiceMock('aa'.repeat(32));
});

import {
  fetchFromRelays,
  publishToRelays,
  MuteStorageAdapter,
  getMuteItems,
  setMuteItems,
  muteUser,
  type MuteItem,
} from './mutes';

const PK1 = '11'.repeat(32);
const PK2 = '22'.repeat(32);
const THREAD1 = 'c0'.repeat(32);

function muteItem(overrides: Partial<MuteItem>): MuteItem {
  return {
    type: 'user',
    id: PK1,
    isPrivate: false,
    addedAt: NOW,
    ...overrides,
  };
}

function muteEvent(
  created_at: number,
  tags: string[][],
  content = ''
): NostrEvent {
  return {
    kind: 10000,
    id: `mute-${created_at}-${tags.length}`,
    pubkey: TEST_PK,
    created_at,
    tags,
    content,
    sig: 'ff'.repeat(64),
  } as unknown as NostrEvent;
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
// fetchFromRelays
// ===========================================================================

describe('mutes fetchFromRelays', () => {
  it('uses only the newest kind:10000 event', async () => {
    relay.muteEvents = [
      muteEvent(NOW - 100, [['p', PK2]]),
      muteEvent(NOW, [['p', PK1]]),
    ];
    const result = await fetchFromRelays();
    expect(result.items.map(i => i.id)).toEqual([PK1]);
    expect(result.relayTimestamp).toBe(NOW);
  });

  it('maps p-tags to user items and e-tags to thread items', async () => {
    relay.muteEvents = [
      muteEvent(NOW, [
        ['p', PK1],
        ['e', THREAD1],
      ]),
    ];
    const result = await fetchFromRelays();
    expect(result.items.find(i => i.id === PK1)?.type).toBe('user');
    expect(result.items.find(i => i.id === THREAD1)?.type).toBe('thread');
  });

  it('decrypts private tags from the event content with isPrivate=true', async () => {
    const privateTags = JSON.stringify([['p', PK2]]);
    const ct = `enc:${privateTags}`;
    cryptoStore.plaintexts.set(ct, privateTags);
    relay.muteEvents = [muteEvent(NOW, [['p', PK1]], ct)];
    const result = await fetchFromRelays();
    const priv = result.items.find(i => i.id === PK2);
    expect(priv?.isPrivate).toBe(true);
    expect(priv?.type).toBe('user');
  });

  it('keeps public items when decryption fails', async () => {
    relay.muteEvents = [muteEvent(NOW, [['p', PK1]], 'enc:unknown')];
    const result = await fetchFromRelays();
    expect(result.items.map(i => i.id)).toEqual([PK1]);
  });

  it('keeps public and private mutes of the same user as separate entries', async () => {
    const privateTags = JSON.stringify([['p', PK1]]);
    const ct = `enc:${privateTags}`;
    cryptoStore.plaintexts.set(ct, privateTags);
    relay.muteEvents = [muteEvent(NOW, [['p', PK1]], ct)];
    const result = await fetchFromRelays();
    expect(result.items).toHaveLength(2); // dedup key is type:id:isPrivate
  });

  it('reports relayContentWasEmpty when no mute list exists on the relays', async () => {
    const result = await fetchFromRelays();
    expect(result.items).toEqual([]);
    expect(result.relayContentWasEmpty).toBe(true);
    expect(result.relayTimestamp).toBe(0);
  });
});

// ===========================================================================
// publishToRelays
// ===========================================================================

describe('mutes publishToRelays', () => {
  it('publishes public p/e tags and encrypts private tags into the content', async () => {
    setMuteItems([
      muteItem({ id: PK1 }),
      muteItem({ id: THREAD1, type: 'thread' }),
      muteItem({ id: PK2, isPrivate: true }),
    ]);
    await publishToRelays();
    expect(relay.published).toHaveLength(1);
    const event = relay.published[0]!;
    expect(event.kind).toBe(10000);
    expect(event.tags).toContainEqual(['p', PK1]);
    expect(event.tags).toContainEqual(['e', THREAD1]);
    expect(event.tags.some(t => t[1] === PK2)).toBe(false);
    const plaintext = cryptoStore.plaintexts.get(event.content);
    expect(JSON.parse(plaintext!)).toEqual([['p', PK2]]);
  });

  it('publishes empty content when there are no private mutes', async () => {
    setMuteItems([muteItem({ id: PK1 })]);
    await publishToRelays();
    expect(relay.published[0]!.content).toBe('');
  });
});

// ===========================================================================
// MuteStorageAdapter — prefixed string format
// ===========================================================================

describe('MuteStorageAdapter', () => {
  const adapter = new MuteStorageAdapter();

  it('round-trips user and thread items through the p:/e: prefix format', () => {
    setMuteItems([
      muteItem({ id: PK1 }),
      muteItem({ id: THREAD1, type: 'thread', isPrivate: true }),
    ]);
    const encoded = adapter.getBrowserItems();
    expect(encoded).toContain(`p:${PK1}`);
    expect(encoded).toContain(`e:${THREAD1}`);

    adapter.setBrowserItems(encoded);
    const items = getMuteItems();
    expect(items.find(i => i.id === PK1)?.type).toBe('user');
    expect(items.find(i => i.id === THREAD1)?.type).toBe('thread');
    expect(items.find(i => i.id === THREAD1)?.isPrivate).toBe(true);
  });

  it('setBrowserItems preserves the existing item objects (isPrivate + addedAt) for known ids', () => {
    const original = muteItem({
      id: PK1,
      isPrivate: true,
      addedAt: NOW - 5000,
    });
    setMuteItems([original]);
    // Relay overwrite arrives without any metadata (bare encoded strings).
    adapter.setBrowserItems([`p:${PK1}`, `p:${PK2}`]);
    const items = getMuteItems();
    const kept = items.find(i => i.id === PK1);
    expect(kept?.isPrivate).toBe(true);
    expect(kept?.addedAt).toBe(NOW - 5000); // NOT overwritten with now()
    const fresh = items.find(i => i.id === PK2);
    expect(fresh?.isPrivate).toBe(false);
    expect(fresh?.addedAt).toBe(NOW);
  });

  it('decodes legacy unprefixed 64-char hex strings as users', () => {
    setMuteItems([]);
    adapter.setBrowserItems([PK1]);
    expect(getMuteItems()[0]).toMatchObject({ type: 'user', id: PK1 });
  });

  it('syncFromRelays diffs encoded strings and flags any set difference', async () => {
    setMuteItems([muteItem({ id: PK1 })]);
    relay.muteEvents = [muteEvent(NOW, [['p', PK2]])];
    const result = await adapter.syncFromRelays();
    expect(result.diff.added).toEqual([`p:${PK2}`]);
    expect(result.diff.removed).toEqual([`p:${PK1}`]);
    expect(result.requiresConfirmation).toBe(true);
  });

  it('identical state → requiresConfirmation=false', async () => {
    muteUser(PK1, false);
    relay.muteEvents = [muteEvent(NOW, [['p', PK1]])];
    const result = await adapter.syncFromRelays();
    expect(result.requiresConfirmation).toBe(false);
  });

  it('applySyncFromRelays overwrite replaces; merge unions', () => {
    setMuteItems([muteItem({ id: PK1 })]);
    adapter.applySyncFromRelays('overwrite', [`p:${PK2}`]);
    expect(adapter.getBrowserItems()).toEqual([`p:${PK2}`]);

    adapter.applySyncFromRelays('merge', [`e:${THREAD1}`]);
    expect(adapter.getBrowserItems().sort()).toEqual(
      [`e:${THREAD1}`, `p:${PK2}`].sort()
    );
  });
});
