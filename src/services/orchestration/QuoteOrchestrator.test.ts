/**
 * Unit tests for QuoteOrchestrator's fetch pipeline: stage order (cache →
 * standard relays → outbound), the stage-3 fail-fast when discovery offers no
 * new relays, and the negative cache that stops repeat searches for unfetchable
 * quotes. This pipeline is the backbone of cross-relay quote rendering.
 *
 * Instantiated via Object.create with all dependencies injected — no real
 * transport, no NDK.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HEX = 'a'.repeat(64);
const EVENT = {
  id: HEX,
  pubkey: 'b'.repeat(64),
  content: 'quoted text',
  tags: [] as string[][],
  kind: 1,
  created_at: 1,
  sig: 'sig',
};

vi.mock('../DiagnosticLogger', () => ({
  diagLog: vi.fn(),
}));
vi.mock('../SystemLogger', () => ({
  SystemLogger: {
    getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));
vi.mock('../transport/NostrTransport', () => ({
  NostrTransport: { getInstance: () => ({}) },
}));
vi.mock('./OutboundRelaysOrchestrator', () => ({
  OutboundRelaysOrchestrator: { getInstance: () => ({}) },
}));
vi.mock('./LongFormOrchestrator', () => ({
  LongFormOrchestrator: { getInstance: () => ({}) },
}));
vi.mock('../NoteService', () => ({
  NoteService: { getInstance: () => ({}) },
}));
vi.mock('../RelayConfig', () => ({
  RelayConfig: { getInstance: () => ({}) },
}));
vi.mock('./Orchestrator', () => ({
  Orchestrator: class {
    constructor(_name: string) {}
  },
}));

import { QuoteOrchestrator } from './QuoteOrchestrator';

type MockFn = ReturnType<typeof vi.fn>;

const getCachedNoteMock = vi.fn<() => typeof EVENT | null>(() => null);

interface InjectableQuoteOrchestrator extends QuoteOrchestrator {
  transport: { fetch: MockFn; getReadRelays: () => string[] };
  relayDiscovery: { getCombinedRelays: MockFn };
  longFormOrch: { fetchAddressableEvent: MockFn };
  noteService: { getCachedNote: MockFn; registerNote: MockFn };
  relayConfig: { getMetadataRelays: () => string[] };
  systemLogger: { info: MockFn; warn: MockFn; error: MockFn };
  fetchingQuotes: Map<string, unknown>;
  failedQuoteFetches: Map<string, number>;
}

function makeOrchestrator(): {
  orch: InjectableQuoteOrchestrator;
  transportFetch: MockFn;
  getCombinedRelays: MockFn;
} {
  const orch = Object.create(
    QuoteOrchestrator.prototype
  ) as InjectableQuoteOrchestrator;
  const transportFetch = vi.fn().mockResolvedValue([]);
  const getCombinedRelays = vi
    .fn()
    .mockResolvedValue(['wss://read.one', 'wss://read.two']);
  orch.transport = {
    fetch: transportFetch,
    getReadRelays: () => ['wss://read.one', 'wss://read.two'],
  };
  orch.relayDiscovery = { getCombinedRelays };
  orch.longFormOrch = { fetchAddressableEvent: vi.fn() };
  orch.noteService = {
    getCachedNote: getCachedNoteMock,
    registerNote: vi.fn(),
  };
  orch.relayConfig = { getMetadataRelays: vi.fn(() => []) };
  orch.systemLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  orch.fetchingQuotes = new Map();
  orch.failedQuoteFetches = new Map();
  return { orch, transportFetch, getCombinedRelays };
}

describe('QuoteOrchestrator.fetchQuotedEvent — stage pipeline', () => {
  let orch: QuoteOrchestrator;
  let transportFetch: ReturnType<typeof vi.fn>;
  let getCombinedRelays: MockFn;

  beforeEach(() => {
    const made = makeOrchestrator();
    orch = made.orch;
    transportFetch = made.transportFetch;
    getCombinedRelays = made.getCombinedRelays;
    getCachedNoteMock.mockReset().mockReturnValue(null);
  });

  it('stage 0: serves a cached note without touching the network', async () => {
    getCachedNoteMock.mockReturnValue(EVENT);
    const result = await orch.fetchQuotedEvent(HEX);
    expect(result).toBe(EVENT);
    expect(transportFetch).not.toHaveBeenCalled();
  });

  it('stage 2: finds the event on the standard read relays', async () => {
    transportFetch.mockResolvedValueOnce([EVENT]);
    const result = await orch.fetchQuotedEvent(HEX);
    expect(result).toBe(EVENT);
    expect(transportFetch).toHaveBeenCalledTimes(1);
    expect(getCombinedRelays).not.toHaveBeenCalled();
  });

  it('stage 3: falls back to outbound relays with skipCache when stage 2 is empty', async () => {
    transportFetch
      .mockResolvedValueOnce([]) // stage 2: empty
      .mockResolvedValueOnce([EVENT]); // stage 3: found
    getCombinedRelays.mockResolvedValue([
      'wss://read.one',
      'wss://read.two',
      'wss://author.outbound.example.com',
    ]);
    const result = await orch.fetchQuotedEvent(HEX, 'c'.repeat(64));
    expect(result).toBe(EVENT);
    expect(transportFetch).toHaveBeenCalledTimes(2);
    const [relays, , , skipCache] = transportFetch.mock.calls[1];
    expect(relays).toContain('wss://author.outbound.example.com');
    expect(skipCache).toBe(true);
  });

  it('stage 2.5: consults indexer relays not already in the read set', async () => {
    orch.relayConfig.getMetadataRelays = vi.fn(() => [
      'wss://indexer.example.com',
    ]);
    transportFetch
      .mockResolvedValueOnce([]) // stage 2
      .mockResolvedValueOnce([EVENT]); // stage 2.5
    const result = await orch.fetchQuotedEvent(HEX);
    expect(result).toBe(EVENT);
    expect(transportFetch).toHaveBeenCalledTimes(2);
    expect(transportFetch.mock.calls[1][0]).toEqual([
      'wss://indexer.example.com',
    ]);
  });
});

describe('QuoteOrchestrator.fetchQuotedEvent — stage 3 fail fast', () => {
  let orch: QuoteOrchestrator;
  let transportFetch: ReturnType<typeof vi.fn>;
  let getCombinedRelays: MockFn;

  beforeEach(() => {
    const made = makeOrchestrator();
    orch = made.orch;
    transportFetch = made.transportFetch;
    getCombinedRelays = made.getCombinedRelays;
  });

  it('skips the redundant re-fetch when discovery offers no new relays', async () => {
    // getCombinedRelays resolves to exactly the standard set (overlap case).
    const result = await orch.fetchQuotedEvent(HEX, 'c'.repeat(64));
    expect(result).toBeNull();
    expect(getCombinedRelays).toHaveBeenCalledTimes(1); // stage 3 was reached…
    expect(transportFetch).toHaveBeenCalledTimes(1); // …but stage 2 was the only network ask
  });

  it('still retries over the same relays when stage 2 threw (transient failure)', async () => {
    transportFetch
      .mockRejectedValueOnce(new Error('connection reset')) // stage 2 throws
      .mockResolvedValueOnce([EVENT]); // stage 3: recovered
    const result = await orch.fetchQuotedEvent(HEX, 'c'.repeat(64));
    expect(result).toBe(EVENT);
    expect(transportFetch).toHaveBeenCalledTimes(2);
  });
});

describe('QuoteOrchestrator.fetchQuotedEvent — negative cache', () => {
  let orch: QuoteOrchestrator;
  let transportFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const made = makeOrchestrator();
    orch = made.orch;
    transportFetch = made.transportFetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not re-run the pipeline within the TTL after a full miss', async () => {
    const first = await orch.fetchQuotedEvent(HEX);
    expect(first).toBeNull();
    expect(transportFetch).toHaveBeenCalledTimes(1); // stage 2 only (fail fast)

    const second = await orch.fetchQuotedEvent(HEX);
    expect(second).toBeNull();
    expect(transportFetch).toHaveBeenCalledTimes(1); // no new network calls
  });

  it('re-attempts the pipeline after the TTL has expired', async () => {
    await orch.fetchQuotedEvent(HEX);
    expect(transportFetch).toHaveBeenCalledTimes(1);

    // Advance past the 15-minute TTL.
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);

    transportFetch.mockResolvedValueOnce([EVENT]);
    const result = await orch.fetchQuotedEvent(HEX);
    expect(result).toBe(EVENT);
    expect(transportFetch).toHaveBeenCalledTimes(2);
  });

  it('an explicit outboundOnly retry bypasses the negative cache and clears it on success', async () => {
    const extraOutbound = ['c'.repeat(64)];
    await orch.fetchQuotedEvent(HEX); // record failure
    expect(transportFetch).toHaveBeenCalledTimes(1); // stage 2 only (fail fast)

    // Retry path: fresh ONLY_RELAY fetch over the outbound set finds the event.
    transportFetch.mockResolvedValueOnce([EVENT]);
    const retried = await orch.fetchQuotedEvent(
      HEX,
      undefined,
      extraOutbound,
      true
    );
    expect(retried).toBe(EVENT);

    // Negative entry was cleared by the success → a normal fetch runs again.
    transportFetch.mockResolvedValueOnce([EVENT]);
    const again = await orch.fetchQuotedEvent(HEX);
    expect(again).toBe(EVENT);
  });
});
