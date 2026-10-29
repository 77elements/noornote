/**
 * Unit tests for QuoteOrchestrator's fetch pipeline: stage order (cache →
 * standard relays → outbound), the stage-3 fail-fast when discovery offers no
 * new relays, the negative cache that stops repeat searches for unfetchable
 * quotes, and the miss flavor (clean EOSE-empty vs. hard transport timeout)
 * that drives the renderer's recovery retry strategy. This pipeline is the
 * backbone of cross-relay quote rendering.
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
  transport: {
    fetch: MockFn;
    fetchWithMeta: MockFn;
    getReadRelays: () => string[];
  };
  relayDiscovery: { getCombinedRelays: MockFn };
  longFormOrch: { fetchAddressableEvent: MockFn };
  noteService: { getCachedNote: MockFn; registerNote: MockFn };
  relayConfig: { getMetadataRelays: () => string[] };
  systemLogger: { info: MockFn; warn: MockFn; error: MockFn };
  fetchingQuotes: Map<string, unknown>;
  failedQuoteFetches: Map<string, { at: number; timedOut: boolean }>;
}

function makeOrchestrator(): {
  orch: InjectableQuoteOrchestrator;
  transportFetch: MockFn;
  fetchWithMeta: MockFn;
  getCombinedRelays: MockFn;
} {
  const orch = Object.create(
    QuoteOrchestrator.prototype
  ) as InjectableQuoteOrchestrator;
  const transportFetch = vi.fn().mockResolvedValue([]);
  const fetchWithMeta = vi
    .fn()
    .mockResolvedValue({ events: [], timedOut: false });
  const getCombinedRelays = vi
    .fn()
    .mockResolvedValue(['wss://read.one', 'wss://read.two']);
  orch.transport = {
    fetch: transportFetch,
    fetchWithMeta,
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
  return { orch, transportFetch, fetchWithMeta, getCombinedRelays };
}

describe('QuoteOrchestrator.fetchQuotedEvent — stage pipeline', () => {
  let orch: QuoteOrchestrator;
  let transportFetch: ReturnType<typeof vi.fn>;
  let fetchWithMeta: ReturnType<typeof vi.fn>;
  let getCombinedRelays: MockFn;

  beforeEach(() => {
    const made = makeOrchestrator();
    orch = made.orch;
    transportFetch = made.transportFetch;
    fetchWithMeta = made.fetchWithMeta;
    getCombinedRelays = made.getCombinedRelays;
    getCachedNoteMock.mockReset().mockReturnValue(null);
  });

  it('stage 0: serves a cached note without touching the network', async () => {
    getCachedNoteMock.mockReturnValue(EVENT);
    const result = await orch.fetchQuotedEvent(HEX);
    expect(result).toBe(EVENT);
    expect(fetchWithMeta).not.toHaveBeenCalled();
    expect(transportFetch).not.toHaveBeenCalled();
  });

  it('stage 2: finds the event on the standard read relays', async () => {
    fetchWithMeta.mockResolvedValueOnce({ events: [EVENT], timedOut: false });
    const result = await orch.fetchQuotedEvent(HEX);
    expect(result).toBe(EVENT);
    expect(fetchWithMeta).toHaveBeenCalledTimes(1);
    expect(getCombinedRelays).not.toHaveBeenCalled();
  });

  it('stage 3: falls back to outbound relays with skipCache when stage 2 is empty', async () => {
    fetchWithMeta.mockResolvedValueOnce({ events: [], timedOut: false }); // stage 2: empty
    transportFetch.mockResolvedValueOnce([EVENT]); // stage 3: found
    getCombinedRelays.mockResolvedValue([
      'wss://read.one',
      'wss://read.two',
      'wss://author.outbound.example.com',
    ]);
    const result = await orch.fetchQuotedEvent(HEX, 'c'.repeat(64));
    expect(result).toBe(EVENT);
    expect(transportFetch).toHaveBeenCalledTimes(1);
    const [relays, , , skipCache] = transportFetch.mock.calls[0];
    expect(relays).toContain('wss://author.outbound.example.com');
    expect(skipCache).toBe(true);
  });

  it('stage 2.5: consults indexer relays not already in the read set', async () => {
    orch.relayConfig.getMetadataRelays = vi.fn(() => [
      'wss://indexer.example.com',
    ]);
    fetchWithMeta
      .mockResolvedValueOnce({ events: [], timedOut: false }) // stage 2
      .mockResolvedValueOnce({ events: [EVENT], timedOut: false }); // stage 2.5
    const result = await orch.fetchQuotedEvent(HEX);
    expect(result).toBe(EVENT);
    expect(fetchWithMeta).toHaveBeenCalledTimes(2);
    expect(fetchWithMeta.mock.calls[1][0]).toEqual([
      'wss://indexer.example.com',
    ]);
  });
});

describe('QuoteOrchestrator.fetchQuotedEvent — stage 3 fail fast', () => {
  let orch: QuoteOrchestrator;
  let transportFetch: ReturnType<typeof vi.fn>;
  let fetchWithMeta: ReturnType<typeof vi.fn>;
  let getCombinedRelays: MockFn;

  beforeEach(() => {
    const made = makeOrchestrator();
    orch = made.orch;
    transportFetch = made.transportFetch;
    fetchWithMeta = made.fetchWithMeta;
    getCombinedRelays = made.getCombinedRelays;
  });

  it('skips the redundant re-fetch when discovery offers no new relays', async () => {
    // getCombinedRelays resolves to exactly the standard set (overlap case).
    const result = await orch.fetchQuotedEvent(HEX, 'c'.repeat(64));
    expect(result).toBeNull();
    expect(getCombinedRelays).toHaveBeenCalledTimes(1); // stage 3 was reached…
    expect(fetchWithMeta).toHaveBeenCalledTimes(1); // …stage 2 asked cleanly…
    expect(transportFetch).toHaveBeenCalledTimes(0); // …and stage 3 skipped the re-ask
  });

  it('still retries over the same relays when stage 2 threw (transient failure)', async () => {
    fetchWithMeta
      .mockRejectedValueOnce(new Error('connection reset')) // stage 2 throws
      .mockResolvedValue({ events: [], timedOut: false });
    transportFetch.mockResolvedValueOnce([EVENT]); // stage 3: recovered
    const result = await orch.fetchQuotedEvent(HEX, 'c'.repeat(64));
    expect(result).toBe(EVENT);
    expect(transportFetch).toHaveBeenCalledTimes(1);
  });
});

describe('QuoteOrchestrator.fetchQuotedEvent — negative cache', () => {
  let orch: QuoteOrchestrator;
  let transportFetch: ReturnType<typeof vi.fn>;
  let fetchWithMeta: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const made = makeOrchestrator();
    orch = made.orch;
    transportFetch = made.transportFetch;
    fetchWithMeta = made.fetchWithMeta;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not re-run the pipeline within the TTL after a full miss', async () => {
    const first = await orch.fetchQuotedEvent(HEX);
    expect(first).toBeNull();
    expect(fetchWithMeta).toHaveBeenCalledTimes(1); // stage 2 only

    const second = await orch.fetchQuotedEvent(HEX);
    expect(second).toBeNull();
    expect(fetchWithMeta).toHaveBeenCalledTimes(1); // no new network calls
  });

  it('re-attempts the pipeline after the TTL has expired', async () => {
    await orch.fetchQuotedEvent(HEX);
    expect(fetchWithMeta).toHaveBeenCalledTimes(1);

    // Advance past the 15-minute TTL.
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);

    fetchWithMeta.mockResolvedValueOnce({ events: [EVENT], timedOut: false });
    const result = await orch.fetchQuotedEvent(HEX);
    expect(result).toBe(EVENT);
    expect(fetchWithMeta).toHaveBeenCalledTimes(2);
  });

  it('an explicit outboundOnly retry bypasses the negative cache and clears it on success', async () => {
    const extraOutbound = ['c'.repeat(64)];
    await orch.fetchQuotedEvent(HEX); // record failure
    expect(fetchWithMeta).toHaveBeenCalledTimes(1); // stage 2 only

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
    fetchWithMeta.mockResolvedValueOnce({ events: [EVENT], timedOut: false });
    const again = await orch.fetchQuotedEvent(HEX);
    expect(again).toBe(EVENT);
  });
});

describe('QuoteOrchestrator.fetchQuotedEventDetailed — miss flavor', () => {
  let orch: QuoteOrchestrator;
  let transportFetch: ReturnType<typeof vi.fn>;
  let fetchWithMeta: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const made = makeOrchestrator();
    orch = made.orch;
    transportFetch = made.transportFetch;
    fetchWithMeta = made.fetchWithMeta;
    getCachedNoteMock.mockReset().mockReturnValue(null);
  });

  it('a stage-2 timeout reports timedOut and the negative cache preserves the flavor', async () => {
    fetchWithMeta.mockResolvedValue({ events: [], timedOut: true });
    const first = await orch.fetchQuotedEventDetailed(HEX);
    expect(first.event).toBeNull();
    expect(first.timedOut).toBe(true);

    // Negative-cache hit rides the flavor along so the renderer's recovery
    // can pick the full-pipeline retry instead of outbound-only.
    const second = await orch.fetchQuotedEventDetailed(HEX);
    expect(second).toEqual({ event: null, timedOut: true });
    expect(fetchWithMeta).toHaveBeenCalledTimes(1); // no re-run within TTL
  });

  it('stage 3 re-asks the same relays after a stage-2 timeout (a timeout is not an answer)', async () => {
    fetchWithMeta.mockResolvedValueOnce({ events: [], timedOut: true }); // stage 2 timed out
    transportFetch.mockResolvedValueOnce([EVENT]); // stage 3: now warm, found
    const result = await orch.fetchQuotedEventDetailed(HEX, 'c'.repeat(64));
    expect(result.event).toBe(EVENT);
    expect(result.timedOut).toBe(false);
    expect(transportFetch).toHaveBeenCalledTimes(1);
  });

  it('a clean EOSE-empty miss reports timedOut false (also on negative-cache hits)', async () => {
    fetchWithMeta.mockResolvedValue({ events: [], timedOut: false });
    const first = await orch.fetchQuotedEventDetailed(HEX);
    expect(first.event).toBeNull();
    expect(first.timedOut).toBe(false);

    const second = await orch.fetchQuotedEventDetailed(HEX);
    expect(second.event).toBeNull();
    expect(second.timedOut).toBe(false);
  });

  it('the NoteService cache beats a fresh negative entry (note:cached rescue path)', async () => {
    fetchWithMeta.mockResolvedValue({ events: [], timedOut: false });
    await orch.fetchQuotedEventDetailed(HEX); // records a negative entry

    // The note arrived via another door → NoteService has it now.
    getCachedNoteMock.mockReturnValue(EVENT);
    const result = await orch.fetchQuotedEventDetailed(HEX);
    expect(result.event).toBe(EVENT);
    expect(result.timedOut).toBe(false);
    expect(fetchWithMeta).toHaveBeenCalledTimes(1); // no re-run, negative entry irrelevant
  });

  it('bypassNegativeCache re-runs the pipeline despite a fresh negative entry', async () => {
    fetchWithMeta.mockResolvedValue({ events: [], timedOut: false });
    await orch.fetchQuotedEventDetailed(HEX); // miss #1 → negative entry

    fetchWithMeta.mockResolvedValue({ events: [EVENT], timedOut: false });
    const result = await orch.fetchQuotedEventDetailed(
      HEX,
      undefined,
      [],
      false,
      true
    );
    expect(result.event).toBe(EVENT);
    expect(fetchWithMeta).toHaveBeenCalledTimes(2);

    // Success cleared the negative entry → a normal fetch runs the pipeline.
    const again = await orch.fetchQuotedEventDetailed(HEX);
    expect(again.event).toBe(EVENT);
    expect(fetchWithMeta).toHaveBeenCalledTimes(3);
  });
});
