/**
 * Unit tests for OutboundRelaysOrchestrator — NIP-65 relay discovery and the
 * outbound relay filter pipeline. This mechanism is the backbone of cross-relay
 * content resolution (quoted notes, profiles) and must never regress silently.
 *
 * The orchestrator is instantiated via Object.create with ALL dependencies
 * injected explicitly (no singleton, no real transport/NDK, no IDB). Heavy
 * modules are still vi.mocked so the import chain stays node-safe.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { transportFetch, outboxWriteRelays } = vi.hoisted(() => ({
  transportFetch: vi.fn(),
  outboxWriteRelays: vi.fn(() => [] as string[]),
}));

vi.mock('../NostrTransport', () => ({
  NostrTransport: {
    getInstance: () => ({
      fetch: transportFetch,
      getOutboxWriteRelays: (pk: string) => outboxWriteRelays(pk),
    }),
  },
}));

vi.mock('../RelayConfig', () => ({
  RelayConfig: {
    getInstance: () => ({
      getReadRelays: () => READ_RELAYS,
      getAggregatorRelays: () => AGGREGATORS,
      getAllRelays: () => READ_RELAYS.map(url => ({ url })),
    }),
  },
}));

vi.mock('../SystemLogger', () => ({
  SystemLogger: {
    getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock('../persistence/NoorDB', () => ({
  openDb: vi.fn().mockResolvedValue(null),
}));

import {
  OutboundRelaysOrchestrator,
  type UserRelayList,
} from './OutboundRelaysOrchestrator';
import { LRUCache } from '../../helpers/LRUCache';

const READ_RELAYS = ['wss://read.one', 'wss://read.two'];
const AGGREGATORS = ['wss://aggregator.one'];

type MockFn = ReturnType<typeof vi.fn>;

interface InjectableOrchestrator extends OutboundRelaysOrchestrator {
  transport: {
    fetch: MockFn;
    getOutboxWriteRelays: (pk: string) => string[];
  };
  relayConfig: {
    getReadRelays: () => string[];
    getAggregatorRelays: () => string[];
    getAllRelays: () => { url: string }[];
  };
  systemLogger: { info: MockFn; warn: MockFn; error: MockFn };
  relayListCache: LRUCache<UserRelayList>;
  restorePromise: Promise<void>;
  stats: {
    totalUsers: number;
    discoveredRelays: number;
    cacheHits: number;
    cacheMisses: number;
  };
  persistToIDB: () => Promise<void>;
  clearIDB: () => Promise<void>;
  discoverUserRelays: (pubkeys: string[]) => Promise<UserRelayList[]>;
  parseRelayListEvent: (event: {
    pubkey: string;
    tags: string[][];
  }) => UserRelayList | null;
}

function relayList(
  pubkey: string,
  write: string[],
  read: string[] = write
): UserRelayList {
  return { pubkey, writeRelays: write, readRelays: read, lastUpdated: 0 };
}

function makeOrchestrator(): {
  orch: InjectableOrchestrator;
  transportFetch: MockFn;
  outbox: MockFn;
} {
  const orch = Object.create(
    OutboundRelaysOrchestrator.prototype
  ) as InjectableOrchestrator;
  const transportFetch = vi.fn().mockResolvedValue([]);
  const outbox = vi.fn(() => [] as string[]);
  orch.transport = {
    fetch: transportFetch,
    getOutboxWriteRelays: (pk: string) => outbox(pk),
  };
  orch.relayConfig = {
    getReadRelays: () => READ_RELAYS,
    getAggregatorRelays: () => AGGREGATORS,
    getAllRelays: () => READ_RELAYS.map(url => ({ url })),
  };
  orch.systemLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  orch.relayListCache = new LRUCache<UserRelayList>(50, 24 * 60 * 60 * 1000);
  orch.restorePromise = Promise.resolve();
  orch.stats = {
    totalUsers: 0,
    discoveredRelays: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
  orch.persistToIDB = vi.fn().mockResolvedValue(undefined);
  orch.clearIDB = vi.fn().mockResolvedValue(undefined);
  return { orch, transportFetch, outbox };
}

describe('OutboundRelaysOrchestrator.getOutboundRelays', () => {
  const { orch } = makeOrchestrator();

  it('returns empty when all author write relays overlap our read set', () => {
    const lists = [relayList('pk1', READ_RELAYS)];
    expect(orch.getOutboundRelays(lists)).toEqual([]);
  });

  it('keeps author write relays we do not already read', () => {
    const lists = [relayList('pk1', ['wss://new.relay.example.com'])];
    expect(orch.getOutboundRelays(lists)).toEqual([
      'wss://new.relay.example.com',
    ]);
  });

  it('filters non-ws protocols and junk hosts', () => {
    const lists = [
      relayList('pk1', [
        'http://insecure.example.com', // invalid protocol
        'wss://localhost', // junk host (no dot)
        'wss://dev.relay.example', // dev-prefixed host
        'wss://good.relay.example.com', // survives
      ]),
    ];
    expect(orch.getOutboundRelays(lists)).toEqual([
      'wss://good.relay.example.com',
    ]);
  });

  it('caps the outbound relays per author', () => {
    const lists = [
      relayList('pk1', [
        'wss://a.example.com',
        'wss://b.example.com',
        'wss://c.example.com',
        'wss://d.example.com',
        'wss://e.example.com',
        'wss://f.example.com',
      ]),
    ];
    expect(orch.getOutboundRelays(lists)).toHaveLength(4);
  });

  it('unions and dedupes across multiple authors', () => {
    const lists = [
      relayList('pk1', ['wss://new.one']),
      relayList('pk2', ['wss://new.one', 'wss://new.two']),
    ];
    expect(orch.getOutboundRelays(lists)).toEqual([
      'wss://new.one',
      'wss://new.two',
    ]);
  });
});

describe('OutboundRelaysOrchestrator.getCombinedRelays', () => {
  it('returns standard relays only when outbound is disabled', async () => {
    const { orch } = makeOrchestrator();
    const discover = vi
      .spyOn(orch as any, 'discoverUserRelays')
      .mockResolvedValue([]);
    await expect(orch.getCombinedRelays(['pk1'], false)).resolves.toEqual(
      READ_RELAYS
    );
    expect(discover).not.toHaveBeenCalled();
  });

  it('falls back to standard relays when discovery throws', async () => {
    const { orch } = makeOrchestrator();
    vi.spyOn(orch as any, 'discoverUserRelays').mockRejectedValue(
      new Error('boom')
    );
    await expect(orch.getCombinedRelays(['pk1'])).resolves.toEqual(READ_RELAYS);
  });

  it('unions standard + author outbound + aggregators without duplicates', async () => {
    const { orch } = makeOrchestrator();
    vi.spyOn(orch as any, 'discoverUserRelays').mockResolvedValue([
      relayList('pk1', ['wss://new.one', ...READ_RELAYS]),
    ]);
    const combined = await orch.getCombinedRelays(['pk1']);
    expect(combined).toEqual([...READ_RELAYS, 'wss://new.one', ...AGGREGATORS]);
  });
});

describe('OutboundRelaysOrchestrator.discoverUserRelays', () => {
  let orch: OutboundRelaysOrchestrator;
  let transportFetch: ReturnType<typeof vi.fn>;
  let outbox: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const made = makeOrchestrator();
    orch = made.orch;
    transportFetch = made.transportFetch;
    outbox = made.outbox;
  });

  it('serves cached relay lists without a network fetch', async () => {
    orch.relayListCache.set('pk1', relayList('pk1', ['wss://cached.one']));
    const lists = await orch.discoverUserRelays(['pk1']);
    expect(transportFetch).not.toHaveBeenCalled();
    expect(lists[0].writeRelays).toEqual(['wss://cached.one']);
  });

  it('parses kind 10002 r-tag variants (none / read / write markers)', async () => {
    transportFetch.mockResolvedValue([
      {
        pubkey: 'pk1',
        tags: [
          ['r', 'wss://both.example.com'],
          ['r', 'wss://readonly.example.com', 'read'],
          ['r', 'wss://writeonly.example.com', 'write'],
        ],
      },
    ]);
    const lists = await orch.discoverUserRelays(['pk1']);
    expect(lists[0].writeRelays).toEqual([
      'wss://both.example.com',
      'wss://writeonly.example.com',
    ]);
    expect(lists[0].readRelays).toEqual([
      'wss://both.example.com',
      'wss://readonly.example.com',
    ]);
  });

  it('falls back to the aggregator list when discovery finds nothing', async () => {
    const lists = await orch.discoverUserRelays(['pk1']);
    expect(lists[0].writeRelays).toEqual(AGGREGATORS);
  });

  it('prefers observed outbox relays over the aggregator default', async () => {
    outbox.mockReturnValue(['wss://seen-on.example.com']);
    const lists = await orch.discoverUserRelays(['pk1']);
    expect(lists[0].writeRelays).toEqual(['wss://seen-on.example.com']);
  });

  it('keeps the aggregator default when the outbox tracker is empty', async () => {
    const lists = await orch.discoverUserRelays(['pk1']);
    expect(lists[0].writeRelays).toEqual(AGGREGATORS);
  });

  it('first-seen relay list wins when an author appears twice in a batch', async () => {
    transportFetch.mockResolvedValue([
      { pubkey: 'pk1', tags: [['r', 'wss://shared.one']] },
      { pubkey: 'pk1', tags: [['r', 'wss://shared.two']] }, // duplicate author
      { pubkey: 'pk2', tags: [['r', 'wss://pk2.example.com']] },
    ]);
    const lists = await orch.discoverUserRelays(['pk1', 'pk2']);
    const pk1 = lists.find(l => l.pubkey === 'pk1');
    const pk2 = lists.find(l => l.pubkey === 'pk2');
    expect(pk1?.writeRelays).toEqual(['wss://shared.one']);
    expect(pk2?.writeRelays).toEqual(['wss://pk2.example.com']);
  });
});

describe('OutboundRelaysOrchestrator.parseRelayListEvent', () => {
  const { orch } = makeOrchestrator();
  const parse = (event: { pubkey: string; tags: string[][] }) =>
    orch.parseRelayListEvent(event);

  it('parses an event with no relay tags into empty lists', () => {
    const list = parse({ pubkey: 'pk1', tags: [] });
    expect(list).not.toBeNull();
    expect(list!.writeRelays).toEqual([]);
    expect(list!.readRelays).toEqual([]);
  });

  it('returns null when tags are missing entirely (throws → caught)', () => {
    expect(
      parse({ pubkey: 'pk1', tags: undefined } as unknown as {
        pubkey: string;
        tags: string[][];
      })
    ).toBeNull();
  });
});
