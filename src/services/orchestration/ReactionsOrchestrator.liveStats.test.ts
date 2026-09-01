// @vitest-environment jsdom
/**
 * Tests for ReactionsOrchestrator.startLiveStats/stopLiveStats — the
 * real-time interaction subscription on the SNV (docs/todos/snv-live-interactions.md).
 *
 * Focus: the memory-leak-sensitive lifecycle (restart-safety, teardown via
 * unsubscribeLive, orchestrator-destroy teardown) and the create-if-missing
 * cache fix (fast reactors arriving before the initial detailed-stats fetch).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

type LiveEventHandler = (event: NostrEvent) => void;

const { liveHandlers, subscribeLiveMock, unsubscribeLiveMock } = vi.hoisted(
  () => {
    const liveHandlers = new Map<string, LiveEventHandler>();
    const subscribeLiveMock =
      vi.fn<
        (
          relays: string[],
          filters: unknown,
          subId: string,
          onEvent: LiveEventHandler
        ) => void
      >();
    const unsubscribeLiveMock = vi.fn<(subId: string) => void>();
    return { liveHandlers, subscribeLiveMock, unsubscribeLiveMock };
  }
);

vi.mock('../transport/NostrTransport', () => ({
  NostrTransport: {
    getInstance: () => ({
      getReadRelays: () => ['wss://relay.test'],
      subscribeLive: (
        relays: string[],
        filters: unknown,
        subId: string,
        onEvent: LiveEventHandler
      ) => {
        subscribeLiveMock(relays, filters, subId, onEvent);
        liveHandlers.set(subId, onEvent);
      },
      unsubscribeLive: (subId: string) => {
        unsubscribeLiveMock(subId);
        liveHandlers.delete(subId);
      },
    }),
  },
}));

vi.mock('../SystemLogger', () => ({
  SystemLogger: {
    getInstance: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock('../RelayConfig', () => ({
  RelayConfig: { getInstance: () => ({}) },
}));

vi.mock('../UserProfileService', () => ({
  UserProfileService: { getInstance: () => ({}) },
}));

vi.mock('../../lists/mutes', () => ({
  isUserMuted: () => ({ public: false, private: false, any: false }),
}));

const { verificationMock } = vi.hoisted(() => ({
  verificationMock: {
    verifyEvent: vi.fn(
      () => ({ valid: true }) as { valid: boolean; error?: string }
    ),
  },
}));

vi.mock('../security/SignatureVerificationService', () => ({
  SignatureVerificationService: { getInstance: () => verificationMock },
}));

import { ReactionsOrchestrator } from './ReactionsOrchestrator';

const NOTE = 'a'.repeat(64);
const NOTE2 = 'f'.repeat(64);

function ev(id: string, kind: number, tags: string[][]): NostrEvent {
  return {
    id,
    pubkey: 'b'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind,
    tags,
    content: '+',
    sig: 'c'.repeat(128),
  } as NostrEvent;
}

describe('ReactionsOrchestrator startLiveStats/stopLiveStats', () => {
  let orchestrator: ReactionsOrchestrator;

  beforeEach(() => {
    liveHandlers.clear();
    subscribeLiveMock.mockClear();
    unsubscribeLiveMock.mockClear();
    orchestrator = ReactionsOrchestrator.getInstance();
  });

  afterEach(() => {
    orchestrator.stopLiveStats(NOTE);
  });

  it('registers the subscription and delivers live events', () => {
    const onStats = vi.fn();
    orchestrator.startLiveStats(NOTE, onStats);

    expect(subscribeLiveMock).toHaveBeenCalledTimes(1);
    const [relays, filters, subId] = subscribeLiveMock.mock.calls[0]!;
    expect(relays).toEqual(['wss://relay.test']);
    expect(subId).toBe(`live-stats-${NOTE}`);
    // hex note → #e filter; reactions+zaps+reposts in one subscription
    const typedFilters = filters as Array<{ kinds: number[]; '#e': string[] }>;
    expect(typedFilters[0]!.kinds).toEqual([7, 9735, 6, 16]);
    expect(typedFilters[0]!['#e']).toEqual([NOTE]);

    // Fast reactor: event arrives with NO cache entry yet → must not be dropped
    liveHandlers.get(subId)?.(ev('r1', 7, [['e', NOTE]]));
    expect(onStats).toHaveBeenCalledWith(expect.objectContaining({ likes: 1 }));
  });

  it('create-if-missing: first event still produces stats', () => {
    const onStats = vi.fn();
    orchestrator.startLiveStats(NOTE, onStats);
    const subId = `live-stats-${NOTE}`;

    // no getDetailedStats call happened → cache created on demand.
    // Zap amount via bolt11: lnbc330n = 33 sats (parseBolt11Amount).
    liveHandlers.get(subId)?.(
      ev('zap1', 9735, [
        ['e', NOTE],
        ['bolt11', 'lnbc330n'],
      ])
    );
    expect(onStats).toHaveBeenCalledWith(expect.objectContaining({ zaps: 33 }));
  });

  it('restart-safety: starting twice replaces the subscription', () => {
    orchestrator.startLiveStats(NOTE, vi.fn());
    orchestrator.startLiveStats(NOTE, vi.fn());
    expect(unsubscribeLiveMock).toHaveBeenCalledWith(`live-stats-${NOTE}`);
    // only the latest handler is registered
    expect(
      Array.from(liveHandlers.keys()).filter(k => k === `live-stats-${NOTE}`)
        .length
    ).toBe(1);
  });

  it('stopLiveStats unsubscribes; stopped handlers no longer fire', () => {
    const onStats = vi.fn();
    orchestrator.startLiveStats(NOTE, onStats);
    orchestrator.stopLiveStats(NOTE);

    expect(unsubscribeLiveMock).toHaveBeenCalledWith(`live-stats-${NOTE}`);
    const handler = liveHandlers.get(`live-stats-${NOTE}`);
    handler?.(ev('r9', 7, [['e', NOTE]]));
    expect(onStats).not.toHaveBeenCalled();
  });

  it('quotes fire both the stats callback and the quoted-repost callback', () => {
    const onStats = vi.fn();
    const onQuotedRepost = vi.fn();
    orchestrator.startLiveStats(NOTE, onStats, onQuotedRepost);
    const subId = `live-stats-${NOTE}`;

    liveHandlers.get(subId)?.(ev('q1', 6, [['q', NOTE]], 'check this'));
    expect(onStats).toHaveBeenCalledWith(
      expect.objectContaining({ quotedReposts: 1 })
    );
    expect(onQuotedRepost).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'q1' })
    );

    // plain repost (no q/a tag) → stats only, no quote callback
    onQuotedRepost.mockClear();
    liveHandlers.get(subId)?.(ev('p1', 6, [['e', NOTE]]));
    expect(onStats).toHaveBeenCalledWith(
      expect.objectContaining({ reposts: 1 })
    );
    expect(onQuotedRepost).not.toHaveBeenCalled();
  });

  it('orchestrator destroy tears down all live stats subscriptions', () => {
    orchestrator.startLiveStats(NOTE, vi.fn());
    orchestrator.destroy();

    expect(unsubscribeLiveMock).toHaveBeenCalledWith(`live-stats-${NOTE}`);
    expect(liveHandlers.has(`live-stats-${NOTE}`)).toBe(false);
  });

  it('rejects invalid-signature receipts before merging (zapper retry protection)', () => {
    const onStats = vi.fn();
    orchestrator.startLiveStats(NOTE2, onStats);
    const subId = `live-stats-${NOTE2}`;

    // Zapper retry with a broken signature — must NOT enter the stats
    verificationMock.verifyEvent.mockReturnValueOnce({
      valid: false,
      error: 'Invalid cryptographic signature',
    });
    liveHandlers.get(subId)?.(
      ev('bad', 9735, [
        ['e', NOTE2],
        ['bolt11', 'lnbc330n'],
      ])
    );
    expect(onStats).not.toHaveBeenCalled();

    // The valid original still works
    liveHandlers.get(subId)?.(
      ev('good', 9735, [
        ['e', NOTE2],
        ['bolt11', 'lnbc330n'],
      ])
    );
    expect(onStats).toHaveBeenCalledWith(expect.objectContaining({ zaps: 33 }));

    orchestrator.stopLiveStats(NOTE2);
  });
});
