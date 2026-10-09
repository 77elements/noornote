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
  kind3Events: [] as unknown[],
  kind30000Events: [] as unknown[],
  published: [] as Array<{ kind: number; tags: string[][]; content: string }>,
  fetchCalls: [] as Array<number[] | undefined>,
  writeRelays: ['wss://relay'],
  decryptThrows: false,
  failFetch: false,
}));

function resetRelay(): void {
  relay.kind3Events = [];
  relay.kind30000Events = [];
  relay.published = [];
  relay.fetchCalls = [];
  relay.writeRelays = ['wss://relay'];
  relay.decryptThrows = false;
  relay.failFetch = false;
  cryptoStore.plaintexts.clear();
}

vi.mock('./relays', () => ({
  getTransport: () => ({}),
  getReadRelays: () => [],
  getWriteRelays: () => relay.writeRelays,
  getCurrentUserPubkey: () => 'aa'.repeat(32),
  requireAuth: () => ({ pubkey: 'aa'.repeat(32) }),
  fetchEvents: async (
    filters: Array<{ kinds?: number[] }>
  ): Promise<unknown[]> => {
    if (relay.failFetch) throw new Error('relay down');
    relay.fetchCalls.push(filters[0]?.kinds);
    const kind = filters[0]?.kinds?.[0];
    if (kind === 3) return relay.kind3Events;
    if (kind === 30000) return relay.kind30000Events;
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
  encryptContent: async () => '',
  decryptContent: async () => null,
}));

vi.mock('../services/AuthService', async () => {
  const { makeAuthServiceMock } = await import('./syncRelayTestMock');
  return makeAuthServiceMock('aa'.repeat(32));
});

// The follow helpers dynamically import these — mock with a shared store.
vi.mock('../helpers/encryptPrivateFollows', () => ({
  encryptPrivateFollows: async (pubkeys: string[]) => {
    const plaintext = JSON.stringify(pubkeys.map(pk => ['p', pk]));
    const ct = `enc:${plaintext}`;
    cryptoStore.plaintexts.set(ct, plaintext);
    return ct;
  },
}));

vi.mock('../helpers/decryptPrivateFollows', () => ({
  decryptPrivateFollows: async (ciphertext: string) => {
    if (relay.decryptThrows) throw new Error('decrypt failed');
    const plaintext = cryptoStore.plaintexts.get(ciphertext);
    if (!plaintext) return [];
    return (JSON.parse(plaintext) as string[][]).map(t => t[1]!);
  },
}));

import {
  fetchFromRelays,
  publishToRelays,
  FollowStorageAdapter,
  getFollowItems,
  setFollowItems,
  clearFollowItems,
  isPrivateFollowsEnabled,
  setPrivateFollowsEnabled,
  type FollowItem,
} from './follows';
import { TypedEventBus } from '../core/TypedEventBus';

const PK1 = '11'.repeat(32);
const PK2 = '22'.repeat(32);
const PK3 = '33'.repeat(32);

function follow(
  pubkey: string,
  overrides: Partial<FollowItem> = {}
): FollowItem {
  return { id: pubkey, pubkey, addedAt: NOW, isPrivate: false, ...overrides };
}

function kind3Event(created_at: number, pTags: string[][]): NostrEvent {
  return {
    kind: 3,
    id: `k3-${created_at}-${pTags.length}`,
    pubkey: TEST_PK,
    created_at,
    tags: pTags,
    content: '',
    sig: 'ff'.repeat(64),
  } as unknown as NostrEvent;
}

function privateFollowsEvent(created_at: number, content: string): NostrEvent {
  return {
    kind: 30000,
    id: `k30000-${created_at}`,
    pubkey: TEST_PK,
    created_at,
    tags: [['d', 'private-follows']],
    content,
    sig: 'ff'.repeat(64),
  } as unknown as NostrEvent;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW * 1000));
  localStorage.clear();
  resetRelay();
  if (isPrivateFollowsEnabled()) setPrivateFollowsEnabled(false);
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

// ===========================================================================
// fetchFromRelays
// ===========================================================================

describe('follows fetchFromRelays', () => {
  it('uses only the newest kind:3 event (replaceable semantics)', async () => {
    relay.kind3Events = [
      kind3Event(NOW - 100, [['p', PK3]]),
      kind3Event(NOW, [
        ['p', PK1],
        ['p', PK2],
      ]),
    ];
    const result = await fetchFromRelays();
    expect(result.items.map(i => i.pubkey).sort()).toEqual([PK1, PK2].sort());
    expect(result.relayTimestamp).toBe(NOW);
  });

  it('extracts relay and petname from p-tags', async () => {
    relay.kind3Events = [
      kind3Event(NOW, [['p', PK1, 'wss://outbox', 'alice']]),
    ];
    const result = await fetchFromRelays();
    expect(result.items[0]).toMatchObject({
      pubkey: PK1,
      relay: 'wss://outbox',
      petname: 'alice',
      isPrivate: false,
    });
  });

  it('merges decrypted private follows with isPrivate=true (feature on)', async () => {
    setPrivateFollowsEnabled(true);
    const ct = `enc:${JSON.stringify([['p', PK2]])}`;
    cryptoStore.plaintexts.set(ct, JSON.stringify([['p', PK2]]));
    relay.kind3Events = [kind3Event(NOW, [['p', PK1]])];
    relay.kind30000Events = [privateFollowsEvent(NOW, ct)];
    const result = await fetchFromRelays();
    expect(result.items).toHaveLength(2);
    expect(result.items.find(i => i.pubkey === PK2)?.isPrivate).toBe(true);
    expect(result.items.find(i => i.pubkey === PK1)?.isPrivate).toBe(false);
  });

  it('does not fetch kind:30000 when private follows are disabled', async () => {
    relay.kind3Events = [kind3Event(NOW, [['p', PK1]])];
    await fetchFromRelays();
    expect(relay.fetchCalls.some(k => k?.[0] === 30000)).toBe(false);
  });

  it('flags decryptionFailed and keeps public items when decryption throws', async () => {
    setPrivateFollowsEnabled(true);
    relay.decryptThrows = true;
    relay.kind3Events = [kind3Event(NOW, [['p', PK1]])];
    relay.kind30000Events = [privateFollowsEvent(NOW, 'enc:broken')];
    const result = await fetchFromRelays();
    expect(result.decryptionFailed).toBe(true);
    expect(result.items.map(i => i.pubkey)).toEqual([PK1]);
  });

  it('deduplicates by pubkey — the later (private) entry wins', async () => {
    setPrivateFollowsEnabled(true);
    const ct = `enc:${JSON.stringify([['p', PK1]])}`;
    cryptoStore.plaintexts.set(ct, JSON.stringify([['p', PK1]]));
    relay.kind3Events = [kind3Event(NOW, [['p', PK1]])];
    relay.kind30000Events = [privateFollowsEvent(NOW, ct)];
    const result = await fetchFromRelays();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.isPrivate).toBe(true);
  });

  it('reports relayContentWasEmpty when nothing is on the relays', async () => {
    const result = await fetchFromRelays();
    expect(result.items).toEqual([]);
    expect(result.relayContentWasEmpty).toBe(true);
    expect(result.relayTimestamp).toBe(0);
  });

  it('does not throw when the relays are down', async () => {
    relay.failFetch = true;
    const result = await fetchFromRelays();
    expect(result.items).toEqual([]);
    expect(result.relayContentWasEmpty).toBe(true);
  });
});

// ===========================================================================
// publishToRelays
// ===========================================================================

describe('follows publishToRelays', () => {
  it('keeps the NIP-02 p-tag slot order: petname requires the empty relay slot', async () => {
    setFollowItems([
      follow(PK1, { petname: 'alice' }), // petname WITHOUT relay → relay slot must be ''
      follow(PK2, { relay: 'wss://outbox' }), // relay only
      follow(PK3), // bare
    ]);
    await publishToRelays();
    const kind3 = relay.published.find(p => p.kind === 3);
    expect(kind3).toBeDefined();
    const tags = kind3!.tags.filter(t => t[0] === 'p');
    expect(tags).toContainEqual(['p', PK1, '', 'alice']);
    expect(tags).toContainEqual(['p', PK2, 'wss://outbox']);
    expect(tags).toContainEqual(['p', PK3]);
    expect(kind3!.content).toBe('');
  });

  it('publishes private follows as kind:30000 d=private-follows with encrypted content', async () => {
    setPrivateFollowsEnabled(true);
    setFollowItems([follow(PK1), follow(PK2, { isPrivate: true })]);
    await publishToRelays();
    const privateEvent = relay.published.find(p => p.kind === 30000);
    expect(privateEvent).toBeDefined();
    expect(privateEvent!.tags).toContainEqual(['d', 'private-follows']);
    const plaintext = cryptoStore.plaintexts.get(privateEvent!.content);
    expect(JSON.parse(plaintext!)).toEqual([['p', PK2]]);
    // Public goes to kind:3 only.
    const kind3 = relay.published.find(p => p.kind === 3)!;
    expect(kind3.tags.some(t => t[1] === PK2)).toBe(false);
  });

  it('does not publish kind:30000 when the feature is off or there are no private items', async () => {
    setFollowItems([follow(PK1)]);
    await publishToRelays();
    expect(relay.published.some(p => p.kind === 30000)).toBe(false);

    setPrivateFollowsEnabled(true);
    relay.published = [];
    await publishToRelays();
    expect(relay.published.some(p => p.kind === 30000)).toBe(false);
  });
});

// ===========================================================================
// FollowStorageAdapter
// ===========================================================================

describe('FollowStorageAdapter', () => {
  const adapter = new FollowStorageAdapter();

  it('computes the diff by pubkey and requires confirmation on any property change', async () => {
    setFollowItems([follow(PK1), follow(PK2, { petname: 'bob' })]);
    relay.kind3Events = [
      kind3Event(NOW, [
        ['p', PK1],
        ['p', PK2, '', 'robert'],
        ['p', PK3],
      ]),
    ];
    const result = await adapter.syncFromRelays();
    expect(result.diff.added.map(i => i.pubkey)).toEqual([PK3]);
    expect(result.diff.removed).toHaveLength(0);
    expect(result.requiresConfirmation).toBe(true); // petname differs + count differs
  });

  it('identical state → requiresConfirmation=false', async () => {
    setFollowItems([follow(PK1, { petname: 'alice' })]);
    relay.kind3Events = [kind3Event(NOW, [['p', PK1, '', 'alice']])];
    const result = await adapter.syncFromRelays();
    expect(result.requiresConfirmation).toBe(false);
  });

  it('maps decryptionFailed to relayContentWasEmpty so private items are preserved', async () => {
    setPrivateFollowsEnabled(true);
    setFollowItems([follow(PK1), follow(PK2, { isPrivate: true })]);
    relay.decryptThrows = true;
    relay.kind3Events = [kind3Event(NOW, [['p', PK1]])];
    relay.kind30000Events = [privateFollowsEvent(NOW, 'enc:broken')];
    const result = await adapter.syncFromRelays();
    expect(result.relayContentWasEmpty).toBe(true);

    adapter.applySyncFromRelays(
      'overwrite',
      result.relayItems,
      result.relayContentWasEmpty
    );
    const items = getFollowItems();
    // Local private item survives the overwrite of an empty/broken relay state.
    expect(items.some(i => i.pubkey === PK2 && i.isPrivate)).toBe(true);
    expect(items.some(i => i.pubkey === PK1)).toBe(true);
  });

  it('overwrite with an empty relay keeps local private items (empty-relay safety)', () => {
    setFollowItems([follow(PK1), follow(PK2, { isPrivate: true })]);
    adapter.applySyncFromRelays('overwrite', [follow(PK1)], true);
    const items = getFollowItems();
    expect(items.map(i => i.pubkey).sort()).toEqual([PK1, PK2].sort());
  });

  it('merge keeps the browser item on pubkey conflict (browser priority)', () => {
    setFollowItems([follow(PK1, { petname: 'mine' })]);
    adapter.applySyncFromRelays('merge', [
      follow(PK1, { petname: 'theirs' }),
      follow(PK3),
    ]);
    const items = getFollowItems();
    expect(items.find(i => i.pubkey === PK1)?.petname).toBe('mine');
    expect(items.some(i => i.pubkey === PK3)).toBe(true);
  });

  it('clearFollowItems does not emit follow:updated (logout cleanup must not trigger sync)', () => {
    let updateEvents = 0;
    const bus = TypedEventBus.getInstance();
    const handler = () => {
      updateEvents++;
    };
    bus.on('follow:updated', handler);
    setFollowItems([follow(PK1)]);
    expect(updateEvents).toBe(1); // set DOES emit
    clearFollowItems();
    expect(updateEvents).toBe(1); // clear does NOT emit
    bus.off('follow:updated', handler);
  });
});
