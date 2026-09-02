// @vitest-environment jsdom
/**
 * Integration tests for SnvZapsListController — the ONE renderer for the SNV
 * zaps/likes lists. Drives the real controller with a scripted reactions/zaps
 * module double and the real ZapsList + TypedEventBus.
 *
 * Core guarantees (the lessons from the failed first attempt):
 * 1. Lifecycle events render SYNCHRONOUSLY in the same tick (no debounce, no
 *    chain hold, no fetch) — true optimistic UI, synchronized with the ISL.
 * 2. Optimistic rows use the EXACT same markup path as receipt rows.
 * 3. Receipt data replaces optimistic rows (reconcile by bolt11) — no dupes.
 * 4. Relay fetches never block rendering; one chained re-render when fresh
 *    data lands (identity check, no loops).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

const ME = 'a'.repeat(64);
const AUTHOR = 'b'.repeat(64);
const NOTE = 'c'.repeat(64);
const INVOICE = 'lnbc50m1zaptestinvoice';

const emptyStats = () => ({
  replyEvents: [] as NostrEvent[],
  repostEvents: [] as NostrEvent[],
  quotedEvents: [] as NostrEvent[],
  reactionEvents: [] as NostrEvent[],
  zapEvents: [] as NostrEvent[],
  lastUpdated: 0,
});

const { reactionsDouble, zapsDouble, likesListCtorMock, orchestratorDoubles } =
  vi.hoisted(() => {
    let cached: ReturnType<typeof emptyStats> | null = null;
    let liveStatsHandler: ((stats: unknown) => void) | null = null;
    const detailFetchEvents: Array<{
      id: string;
      kind: number;
      pubkey: string;
      tags: string[][];
      content: string;
      sig: string;
    }> = [];
    const liveStatsHandlers = new Map<
      string,
      (event: {
        id: string;
        kind: number;
        pubkey: string;
        tags: string[][];
        content: string;
        sig: string;
      }) => void
    >();
    const orchestratorDoubles = { detailFetchEvents, liveStatsHandlers };
    return {
      likesListCtorMock: vi.fn(),
      orchestratorDoubles,
      reactionsDouble: {
        get cached() {
          return cached;
        },
        get liveStatsHandler() {
          return liveStatsHandler;
        },
        setCached: (s: ReturnType<typeof emptyStats> | null) => {
          cached = s;
        },
        peekDetailedStats: vi.fn((_noteId: string) =>
          cached && cached.lastUpdated > 0 ? cached : null
        ),
        getDetailedStats: vi.fn(
          async (_noteId: string) => cached ?? emptyStats()
        ),
        startLiveStats: vi.fn(
          (noteId: string, onStats: (stats: unknown) => void) => {
            liveStatsHandler = onStats;
          }
        ),
        stopLiveStats: vi.fn((_noteId: string) => {
          liveStatsHandler = null;
        }),
      },
      zapsDouble: {
        pending: [] as Array<Record<string, unknown>>,
        reconcileZapStates: vi.fn(
          (_noteId: string, zapEvents: NostrEvent[]) => {
            // mirror ZapService.reconcileZapStates: drop entries whose receipt is present
            const invoices = new Set(
              zapEvents
                .map(e => e.tags?.find(t => t[0] === 'bolt11')?.[1])
                .filter(Boolean)
            );
            zapsDouble.pending = zapsDouble.pending.filter(
              p => !invoices.has(p.invoice as string)
            );
          }
        ),
        getZapPendingStates: vi.fn((noteId: string) =>
          zapsDouble.pending.filter(p => p.noteId === noteId)
        ),
        getUnconfirmedZapAmount: vi.fn((noteId: string) =>
          zapsDouble.pending
            .filter(p => p.noteId === noteId)
            .reduce((t, p) => t + (p.amount as number), 0)
        ),
      },
    };
  });

vi.mock('../../../services/UserProfileService', () => ({
  UserProfileService: {
    getInstance: () => ({
      getUserProfile: vi.fn(() => ({
        pubkey: ME,
        name: 'alp',
        display_name: 'Alp',
        picture: 'https://img.test/alp.png',
      })),
    }),
  },
}));
vi.mock('../../../services/AuthService', () => ({
  AuthService: {
    getInstance: () => ({ getCurrentUser: () => ({ pubkey: ME }) }),
  },
}));
vi.mock('../../../core/ModuleLoader', () => ({
  ModuleLoader: { getInstance: () => ({ getApi: () => null }) },
}));
vi.mock('../../ui/UserHoverCard', () => ({
  UserHoverCard: { getInstance: () => ({ show: vi.fn(), hide: vi.fn() }) },
}));
vi.mock('../../ui/Tooltip', () => ({ Tooltip: { attach: vi.fn() } }));
vi.mock('../../../services/ViewNavigationController', () => ({
  getViewNavigationController: () => ({ openView: vi.fn() }),
}));
// LikesList pulls a deep import chain (lists/file needs Electron APIs at
// module level) — not under test here, stub it.
vi.mock('../../../services/transport/NostrTransport', () => ({
  NostrTransport: {
    getInstance: () => ({
      getReadRelays: () => ['wss://relay.test'],
      subscribeLive: (
        _relays: string[],
        _filters: unknown,
        subId: string,
        onEvent: (e: {
          id: string;
          kind: number;
          pubkey: string;
          tags: string[][];
          content: string;
          sig: string;
        }) => void
      ) => {
        orchestratorDoubles.liveStatsHandlers.set(subId, onEvent);
      },
      unsubscribeLive: (subId: string) => {
        orchestratorDoubles.liveStatsHandlers.delete(subId);
      },
      fetch: vi.fn(async () => []),
      subscribe: vi.fn(
        (
          _relays: string[],
          _filters: unknown,
          handlers: {
            onEvent: (e: {
              id: string;
              kind: number;
              pubkey: string;
              tags: string[][];
              content: string;
              sig: string;
            }) => void;
            onEose: () => void;
          }
        ) => {
          orchestratorDoubles.detailFetchEvents.forEach(e =>
            handlers.onEvent(e)
          );
          void Promise.resolve().then(() => handlers.onEose());
          return Promise.resolve({ close: vi.fn() });
        }
      ),
    }),
  },
}));
vi.mock('../../ui/LikesList', () => ({
  LikesList: class {
    private element = document.createElement('div');
    constructor(...args: unknown[]) {
      likesListCtorMock(...args);
    }
    async init(): Promise<void> {}
    getElement(): HTMLElement {
      return this.element;
    }
  },
}));

import { SnvZapsListController } from './SnvZapsListController';
import { TypedEventBus } from '../../../core/TypedEventBus';
import { ReactionsOrchestrator } from '../../../services/orchestration/ReactionsOrchestrator';

function receipt(id: string, bolt11: string) {
  return {
    id,
    kind: 9735,
    pubkey: 'd'.repeat(64),
    tags: [['bolt11', bolt11]],
    content: '',
  } as NostrEvent;
}

function snvShell(): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = '<div class="isl"></div>';
  document.body.appendChild(el);
  return el;
}

function newController(): SnvZapsListController {
  return new SnvZapsListController(
    () => reactionsDouble as never,
    async () => reactionsDouble as never,
    () => zapsDouble as never
  );
}

describe('SnvZapsListController', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    reactionsDouble.setCached(null);
    reactionsDouble.peekDetailedStats.mockClear();
    reactionsDouble.getDetailedStats.mockClear();
    zapsDouble.pending = [];
    zapsDouble.reconcileZapStates.mockClear();
  });

  it('reload flow: attach with empty cache → fetch resolves → receipt row renders', async () => {
    const shell = snvShell();
    const controller = newController();
    controller.attach(NOTE, AUTHOR, shell);

    // background fetch lands with one receipt for our note
    reactionsDouble.setCached({
      ...emptyStats(),
      zapEvents: [receipt('r1', INVOICE)],
      lastUpdated: Date.now(),
    });
    await vi.waitFor(() => {
      expect(shell.querySelectorAll('.zaps-list__badge').length).toBe(1);
    });
    expect(shell.querySelector('.zaps-list__text')!.textContent).toBe(
      'Zapped by Alp'
    );
    controller.detach(NOTE);
  });

  it('zap:succeeded renders the row SYNCHRONOUSLY (frozen timers prove: no debounce, no chain, no fetch)', async () => {
    vi.useFakeTimers();
    const shell = snvShell();
    const controller = newController();
    controller.attach(NOTE, AUTHOR, shell);
    zapsDouble.pending.push({
      invoice: INVOICE,
      noteId: NOTE,
      amount: 50,
      state: 'succeeded',
      startedAt: 0,
      comment: 'Great post!',
    });

    // same tick — no await, no waitFor
    TypedEventBus.getInstance().emit('zap:succeeded', {
      noteId: NOTE,
      invoice: INVOICE,
      amount: 50,
    });

    // Flush microtasks ONLY — fake timers stay frozen, so a 400ms debounce
    // or relay fetch could never have produced this row.
    await vi.advanceTimersByTimeAsync(0);

    const badge = shell.querySelector('.zaps-list__badge')!;
    expect(badge).not.toBeNull();
    // EXACT same display as receipt rows: "⚡ 50 Great post!"
    expect(badge.querySelector('.zaps-list__amount')!.textContent).toBe('50');
    expect(badge.querySelector('.zaps-list__text')!.textContent).toBe(
      'Great post!'
    );
    // no invented pending styling
    expect(badge.classList.contains('pulsate')).toBe(false);
    expect(badge.classList.contains('zaps-list__badge--pending')).toBe(false);
    vi.useRealTimers();
    controller.detach(NOTE);
  });

  it('zap:succeeded without comment renders "Zapped by <own username>"', async () => {
    vi.useFakeTimers();
    const shell = snvShell();
    const controller = newController();
    controller.attach(NOTE, AUTHOR, shell);
    zapsDouble.pending.push({
      invoice: INVOICE,
      noteId: NOTE,
      amount: 50,
      state: 'succeeded',
      startedAt: 0,
    });

    TypedEventBus.getInstance().emit('zap:succeeded', {
      noteId: NOTE,
      invoice: INVOICE,
      amount: 50,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(shell.querySelector('.zaps-list__text')!.textContent).toBe(
      'Zapped by Alp'
    );
    vi.useRealTimers();
    controller.detach(NOTE);
  });

  it('receipt data replaces the optimistic row (reconcile by bolt11, no duplicate)', async () => {
    vi.useFakeTimers();
    const shell = snvShell();
    const controller = newController();
    controller.attach(NOTE, AUTHOR, shell);

    // optimistic row first
    zapsDouble.pending.push({
      invoice: INVOICE,
      noteId: NOTE,
      amount: 50,
      state: 'succeeded',
      startedAt: 0,
    });
    TypedEventBus.getInstance().emit('zap:succeeded', {
      noteId: NOTE,
      invoice: INVOICE,
      amount: 50,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(shell.querySelectorAll('.zaps-list__badge').length).toBe(1);

    // receipt arrives → cache updated (orchestrator live merge) → refresh
    reactionsDouble.setCached({
      ...emptyStats(),
      zapEvents: [receipt('r1', INVOICE)],
      lastUpdated: Date.now(),
    });
    controller.refresh(NOTE);
    await vi.waitFor(() => {
      const text = shell.querySelector('.zaps-list__text')!.textContent;
      expect(text).toBe('Zapped by Alp'); // receipt row (no comment in receipt)
    });
    expect(shell.querySelectorAll('.zaps-list__badge').length).toBe(1);
    vi.useRealTimers();
    controller.detach(NOTE);
  });

  it('zap:failed removes the row synchronously', async () => {
    vi.useFakeTimers();
    const shell = snvShell();
    const controller = newController();
    controller.attach(NOTE, AUTHOR, shell);
    zapsDouble.pending.push({
      invoice: INVOICE,
      noteId: NOTE,
      amount: 50,
      state: 'succeeded',
      startedAt: 0,
    });
    TypedEventBus.getInstance().emit('zap:succeeded', {
      noteId: NOTE,
      invoice: INVOICE,
      amount: 50,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(shell.querySelectorAll('.zaps-list__badge').length).toBe(1);

    zapsDouble.pending = [];
    TypedEventBus.getInstance().emit('zap:failed', {
      noteId: NOTE,
      invoice: INVOICE,
      amount: 50,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(shell.querySelectorAll('.zaps-list__badge').length).toBe(0);
    expect(shell.querySelector('.zaps-list')).toBeNull();
    vi.useRealTimers();
    controller.detach(NOTE);
  });

  it('lifecycle events for other notes are ignored', () => {
    const shell = snvShell();
    const controller = newController();
    controller.attach(NOTE, AUTHOR, shell);

    TypedEventBus.getInstance().emit('zap:succeeded', {
      noteId: 'e'.repeat(64),
      invoice: INVOICE,
      amount: 50,
    });

    expect(shell.querySelector('.zaps-list')).toBeNull();
    controller.detach(NOTE);
  });
});

describe('SnvZapsListController — view-agnostic options (article support)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    reactionsDouble.setCached(null);
    reactionsDouble.peekDetailedStats.mockClear();
    reactionsDouble.getDetailedStats.mockClear();
    zapsDouble.pending = [];
    zapsDouble.reconcileZapStates.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('detailedStatsEventId is passed through to getDetailedStats (article dual-tag search)', async () => {
    const shell = snvShell();
    const controller = newController();
    const articleNoteId = '30023:b'.repeat(1) + 'b'.repeat(58); // addressable id
    controller.attach(articleNoteId, AUTHOR, shell, {
      detailedStatsEventId: 'd'.repeat(64),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(reactionsDouble.getDetailedStats).toHaveBeenCalledWith(
      articleNoteId,
      'd'.repeat(64)
    );
    controller.detach(articleNoteId);
  });

  it('liveStats: starts the subscription once, onStats fires the callback and re-renders, detach stops it', async () => {
    const shell = snvShell();
    const controller = newController();
    const onStats = vi.fn();
    reactionsDouble.setCached({
      ...emptyStats(),
      zapEvents: [receipt('r1', 'lnbc50m1a')],
      lastUpdated: Date.now(),
    });

    controller.attach(NOTE, AUTHOR, shell, { liveStats: { onStats } });
    await vi.advanceTimersByTimeAsync(0);

    expect(reactionsDouble.startLiveStats).toHaveBeenCalledTimes(1);
    expect(reactionsDouble.startLiveStats).toHaveBeenCalledWith(
      NOTE,
      expect.any(Function)
    );

    // Orchestrator merged new data into the cache → fires the callback
    const handler = reactionsDouble.liveStatsHandler!;
    reactionsDouble.setCached({
      ...emptyStats(),
      zapEvents: [receipt('r1', 'lnbc50m1a'), receipt('r2', 'lnbc21m1b')],
      lastUpdated: Date.now(),
    });
    handler({ zaps: 71 } as never);
    await vi.advanceTimersByTimeAsync(0);

    expect(onStats).toHaveBeenCalledWith({ zaps: 71 });
    expect(shell.querySelectorAll('.zaps-list__badge').length).toBe(2);

    controller.detach(NOTE);
    expect(reactionsDouble.stopLiveStats).toHaveBeenCalledWith(NOTE);
  });

  it('likesContext is passed to the LikesList (NIP-25-compliant tags for articles)', async () => {
    const shell = snvShell();
    const controller = newController();
    const articleEvent = { id: 'd'.repeat(64), kind: 30023 } as never;
    reactionsDouble.setCached({
      ...emptyStats(),
      reactionEvents: [
        {
          id: 'x1',
          kind: 7,
          pubkey: 'e'.repeat(64),
          tags: [['a', '30023:b'.repeat(1)]],
          content: '+',
        } as never,
      ],
      lastUpdated: Date.now(),
    });

    controller.attach(NOTE, AUTHOR, shell, {
      detailedStatsEventId: 'd'.repeat(64),
      likesContext: articleEvent,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(likesListCtorMock).toHaveBeenCalled();
    const args = likesListCtorMock.mock.calls[0];
    expect(args[3]).toBe(articleEvent); // originalEvent for NIP-25 addressable tags
    controller.detach(NOTE);
  });
});

describe('SnvZapsListController — like flow integration (real orchestrator)', () => {
  const NOTE = 'c'.repeat(64);
  const AUTHOR = 'b'.repeat(64);

  function reactionEvent(
    id: string,
    pubkey: string,
    emoji: string
  ): NostrEvent {
    return {
      id,
      kind: 7,
      pubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['e', NOTE]],
      content: emoji,
      sig: 'c'.repeat(128),
    } as never;
  }

  it('existing reactions survive the own-like live echo (no wipe regression)', async () => {
    const orchestrator = ReactionsOrchestrator.getInstance();
    // Initial detailed-stats fetch delivers 2 existing reactions (different authors)
    orchestratorDoubles.detailFetchEvents.push(
      reactionEvent('rA', 'e'.repeat(64), '👍'),
      reactionEvent('rB', 'f'.repeat(64), '🚀')
    );
    await orchestrator.getDetailedStats(NOTE);

    const shell = snvShell();
    const controller = new SnvZapsListController(
      () => orchestrator as never,
      async () => orchestrator as never,
      () => null
    );
    controller.attach(NOTE, AUTHOR, shell);
    await new Promise(resolve => setTimeout(resolve, 0));

    // LikesList received BOTH existing reactions
    const initialArgs = likesListCtorMock.mock.calls.at(-1)![0] as NostrEvent[];
    expect(initialArgs).toHaveLength(2);

    // The user's own like: LiveUpdatesManager owns the live-stats subscription
    // (model it) — the echo merges into the EXISTING cache (2 + 1 = 3)…
    const onStats = vi.fn();
    orchestrator.startLiveStats(NOTE, onStats);
    const handler = orchestratorDoubles.liveStatsHandlers.get(
      `live-stats-${NOTE}`
    )!;
    handler(reactionEvent('rOWN', 'a'.repeat(64), '🎉'));
    expect(onStats).toHaveBeenCalledWith(expect.objectContaining({ likes: 3 }));

    // …and the SNV's onStatsUpdate wiring refreshes the controller, whose
    // rebuild MUST contain all three reactions (the reported bug wiped the
    // two existing ones and kept only the own emoji).
    controller.refresh(NOTE);
    await new Promise(resolve => setTimeout(resolve, 0));

    const finalArgs = likesListCtorMock.mock.calls.at(-1)![0] as NostrEvent[];
    expect(finalArgs).toHaveLength(3);
    expect(finalArgs.map(e => e.content)).toEqual(
      expect.arrayContaining(['👍', '🚀', '🎉'])
    );

    controller.detach(NOTE);
    orchestrator.stopLiveStats(NOTE);
  });
});
