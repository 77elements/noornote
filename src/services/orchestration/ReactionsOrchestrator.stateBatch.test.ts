// @vitest-environment jsdom
/**
 * Tests for ReactionsOrchestrator.ensureStatsBatched — the micro-batch queue
 * that replaced the per-card `getDetailedStats` state check (the "every
 * mounted note fires a reactions REQ to every read relay" pattern relays
 * rate-limit on, see the nos.lol operator's client audit).
 *
 * Focus: coalescing concurrent checks into ONE batch REQ, cache freshness,
 * and sharing in-flight per-note fetches instead of racing a batch against
 * them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

const { subscribeMock, transportFetchMock } = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
  transportFetchMock: vi.fn(),
}));

vi.mock('../services/DiagnosticLogger', () => ({
  diagLog: vi.fn(),
}));

vi.mock('../SystemLogger', async () => {
  const { systemLoggerMock } = await import('./orchestratorTestMocks');
  return systemLoggerMock;
});

vi.mock('../RelayConfig', async () => {
  const { relayConfigMock } = await import('./orchestratorTestMocks');
  return relayConfigMock;
});

vi.mock('../UserProfileService', async () => {
  const { userProfileMock } = await import('./orchestratorTestMocks');
  return userProfileMock;
});

vi.mock('../../lists/mutes', async () => {
  const { mutesMock } = await import('./orchestratorTestMocks');
  return mutesMock;
});

vi.mock('../security/SignatureVerificationService', () => ({
  SignatureVerificationService: {
    getInstance: () => ({ verifyEvent: vi.fn(() => ({ valid: true })) }),
  },
}));

vi.mock('../transport/NostrTransport', () => ({
  NostrTransport: {
    getInstance: () => ({
      getReadRelays: () => ['wss://relay.test'],
      subscribe: subscribeMock,
      fetch: transportFetchMock,
      subscribeLive: vi.fn(),
      unsubscribeLive: vi.fn(),
    }),
  },
}));

import { ReactionsOrchestrator } from './ReactionsOrchestrator';

const NOTE_A = 'a'.repeat(64);
const NOTE_B = 'b'.repeat(64);

function reactorEvent(id: string, noteId: string, kind = 7): NostrEvent {
  return {
    id,
    pubkey: 'p'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind,
    tags: [['e', noteId]],
    content: '+',
    sig: 's'.repeat(128),
  } as unknown as NostrEvent;
}

/** Subscribe mock: accepts filters, lets the test deliver events, then EOSE. */
function scriptSubscribe(deliver: (filters: never[]) => NostrEvent[]): void {
  subscribeMock.mockImplementation(
    (
      _relays: string[],
      filters: never[],
      handlers: { onEvent: (e: never) => void; onEose: () => void }
    ) => {
      deliver(filters).forEach(e => handlers.onEvent(e as never));
      void Promise.resolve().then(() => handlers.onEose());
      return Promise.resolve({ close: vi.fn() });
    }
  );
}

describe('ReactionsOrchestrator ensureStatsBatched', () => {
  let orchestrator: ReactionsOrchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    subscribeMock.mockReset();
    transportFetchMock.mockReset();
    transportFetchMock.mockResolvedValue([]); // deletion sweep: nothing
    orchestrator = ReactionsOrchestrator.getInstance();
  });

  afterEach(() => {
    orchestrator.destroy();
    vi.useRealTimers();
  });

  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it('coalesces concurrent checks for multiple notes into ONE batch REQ', async () => {
    scriptSubscribe(() => [reactorEvent('e1', NOTE_A)]);

    const p1 = orchestrator.ensureStatsBatched(NOTE_A);
    const p2 = orchestrator.ensureStatsBatched(NOTE_B);
    expect(subscribeMock).not.toHaveBeenCalled(); // debounce window

    await vi.advanceTimersByTimeAsync(80); // flush window (75ms)
    await p1;
    await p2;

    // Exactly one subscription (the batch) — not one per note
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    const filters = subscribeMock.mock.calls[0]![1] as Array<{
      '#e'?: string[];
    }>;
    const eTagged = filters.filter(f => Array.isArray(f['#e']));
    const batchedIds = new Set(eTagged.flatMap(f => f['#e']!));
    expect(batchedIds.has(NOTE_A)).toBe(true);
    expect(batchedIds.has(NOTE_B)).toBe(true);
  });

  it('resolves instantly from fresh cache without any REQ', async () => {
    scriptSubscribe(() => [reactorEvent('e1', NOTE_A)]);

    void orchestrator.ensureStatsBatched(NOTE_A);
    await vi.advanceTimersByTimeAsync(80);
    const callsAfterFirst = subscribeMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Second call: cache is fresh → no new REQ
    await orchestrator.ensureStatsBatched(NOTE_A);
    expect(subscribeMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('shares an in-flight per-note fetch instead of racing a batch', async () => {
    scriptSubscribe(() => [reactorEvent('e1', NOTE_A)]);

    // Per-note detailed fetch in flight (SNV-style)
    const detailed = orchestrator.getDetailedStats(NOTE_A);
    await flushMicrotasks();
    const perNoteCalls = subscribeMock.mock.calls.length;
    expect(perNoteCalls).toBeGreaterThan(0);

    // State check joins the in-flight fetch — no extra batch subscription
    await orchestrator.ensureStatsBatched(NOTE_A);
    await detailed;

    expect(subscribeMock.mock.calls.length).toBe(perNoteCalls);
  });

  it('repeated queued checks for the same note share one promise', async () => {
    scriptSubscribe(() => [reactorEvent('e1', NOTE_A)]);

    const p1 = orchestrator.ensureStatsBatched(NOTE_A);
    const p2 = orchestrator.ensureStatsBatched(NOTE_A);
    expect(p1).toBe(p2);

    await vi.advanceTimersByTimeAsync(80);
    await p1;
    await p2;
  });

  it('populates the detailed-stats cache readable via peekDetailedStats', async () => {
    scriptSubscribe(() => [reactorEvent('e1', NOTE_A)]);

    void orchestrator.ensureStatsBatched(NOTE_A);
    await vi.advanceTimersByTimeAsync(80);
    await flushMicrotasks();

    const stats = orchestrator.peekDetailedStats(NOTE_A);
    expect(stats).not.toBeNull();
    expect(stats!.reactionEvents).toHaveLength(1);
  });

  it('batches at most STATE_CHECK_CHUNK_SIZE ids per REQ round', async () => {
    scriptSubscribe(() => []);
    const ids = Array.from({ length: 3 }, (_, i) =>
      (i.toString(16) as string).padEnd(64, '0')
    );

    void orchestrator.ensureStatsBatched(ids[0]!);
    void orchestrator.ensureStatsBatched(ids[1]!);
    void orchestrator.ensureStatsBatched(ids[2]!);
    await vi.advanceTimersByTimeAsync(80);
    await flushMicrotasks();

    // 3 ids << 50 → one batch subscription
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    // No events collected → no remote-deletion sweep REQ
    expect(transportFetchMock).not.toHaveBeenCalled();
  });

  it('falls through to the per-note path for article ids (unbatchable)', async () => {
    scriptSubscribe(() => []);

    const articleId = `30023:${'a'.repeat(64)}:my-article`;
    await orchestrator.ensureStatsBatched(articleId);

    // Article path = the 4 per-note subscription fetches; each resolves via
    // the scripted EOSE. Crucially NOT a single batch subscription.
    expect(subscribeMock.mock.calls.length).toBe(4);
  });
});
