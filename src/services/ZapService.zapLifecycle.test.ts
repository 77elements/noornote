/**
 * TDD tests for the zap payment lifecycle (wallet-side success criterion:
 * "the sats left the wallet"). ZapService is the single lifecycle authority:
 *
 * - payment resolved (preimage)        → zap:succeeded, permanent optimistic state
 * - payment definitively failed        → no optimistic state (existing toast path)
 * - payment ambiguous (NWC timeout)    → zap:pending + wallet verification loop
 *   - wallet says paid                 → zap:succeeded
 *   - wallet says unpaid (NOT_FOUND)   → zap:failed + full revert (USER_ZAPS removed)
 *   - wallet unreachable               → stays 'verifying', keeps polling, NO revert
 * - receipt confirmation (kind 9735, signature-verified, bolt11-matched) upgrades
 *   'verifying' → 'succeeded' and hands a 'succeeded' entry over to receipt-based
 *   stats (entry removed → no double count).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ME = 'a'.repeat(64);
const AUTHOR = 'b'.repeat(64);
const NOTE = 'c'.repeat(64);
const NOTE2 = 'd'.repeat(64);
const INVOICE = 'lnbc50m1zaptestinvoice';
const INVOICE2 = 'lnbc21m1zaptestsecond';
const INVOICE3 = 'lnbc7m1zaptestthird';

const { nwcMock, transportMock, perAccountStore } = vi.hoisted(() => {
  const nwcMock = {
    isConnected: vi.fn<() => boolean>(() => true),
    payInvoice: vi.fn(),
    lookupInvoice: vi.fn(),
    listTransactions: vi.fn(async () => []),
  };
  let receiptHandler: ((event: unknown) => void) | null = null;
  const transportMock = {
    getReadRelays: vi.fn(() => ['wss://relay.test']),
    subscribe: vi.fn(
      (
        _relays: string[],
        _filters: unknown,
        handlers: { onEvent: (event: unknown) => void }
      ) => {
        receiptHandler = handlers.onEvent;
        return { close: vi.fn() };
      }
    ),
    deliverReceipt: (event: unknown) => receiptHandler?.(event),
  };
  const store = new Map<string, unknown>();
  const perAccountStore = {
    get: (key: string, fallback: unknown) =>
      store.has(key) ? store.get(key) : fallback,
    set: (key: string, value: unknown) => void store.set(key, value),
    delete: (key: string) => void store.delete(key),
    _map: store,
  };
  return { nwcMock, transportMock, perAccountStore };
});

vi.mock('./NWCService', () => ({
  NWCService: { getInstance: () => nwcMock },
}));
vi.mock('./transport/NostrTransport', () => ({
  NostrTransport: { getInstance: () => transportMock },
}));
vi.mock('./PerAccountLocalStorage', () => ({
  PerAccountLocalStorage: { getInstance: () => perAccountStore },
  StorageKeys: {
    USER_ZAPS: 'user_zaps',
    OWN_ANON_ZAP_INVOICES: 'own_anon_zaps',
  },
}));
vi.mock('./AuthService', () => ({
  AuthService: {
    getInstance: () => ({ getCurrentUser: () => ({ pubkey: ME }) }),
  },
}));
vi.mock('./SystemLogger', () => ({
  SystemLogger: {
    getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));
vi.mock('./ErrorService', () => ({
  ErrorService: { getInstance: () => ({ catch: vi.fn() }) },
}));
vi.mock('./ToastService', () => ({
  ToastService: { show: vi.fn() },
}));
vi.mock('./RelayConfig', () => ({
  RelayConfig: {
    getInstance: () => ({ getReadRelays: () => ['wss://relay.test'] }),
  },
}));
vi.mock('./UserProfileService', () => ({
  UserProfileService: { getInstance: () => ({ getUserProfile: vi.fn() }) },
}));
vi.mock('./orchestration/OutboundRelaysOrchestrator', () => ({
  OutboundRelaysOrchestrator: { getInstance: () => ({}) },
}));
vi.mock('./orchestration/ProfileOrchestrator', () => ({
  ProfileOrchestrator: { getInstance: () => ({}) },
}));
vi.mock('./security/SignatureVerificationService', () => ({
  SignatureVerificationService: {
    getInstance: () => ({ verifyEvent: () => ({ valid: true }) }),
  },
}));
vi.mock('./PlatformService', () => ({
  PlatformService: {
    getInstance: () => ({ isBrowser: false, isDesktop: false }),
  },
}));
vi.mock('./NostrToolsAdapter', () => ({
  generateSecretKey: () => new Uint8Array(32),
  finalizeEvent: (event: unknown) => event,
}));

import { ZapService } from './ZapService';
import { TypedEventBus } from '../core/TypedEventBus';

type AnyFn = (...args: unknown[]) => unknown;

function newService(): ZapService {
  (ZapService as unknown as { instance: ZapService | null }).instance = null;
  const svc = ZapService.getInstance();
  (svc as unknown as Record<string, AnyFn>).getLNURLFromProfile = vi.fn(
    async () => 'lnurlw://test'
  );
  (svc as unknown as Record<string, AnyFn>).createZapRequestEvent = vi.fn(
    async () => ({ id: 'zapreq', tags: [] })
  );
  (svc as unknown as Record<string, AnyFn>).fetchInvoice = vi.fn(
    async () => INVOICE
  );
  (svc as unknown as Record<string, AnyFn>).markOwnAnonZapInvoice = vi.fn();
  (svc as unknown as Record<string, AnyFn>).payWithWebLN = vi.fn(async () => ({
    success: true,
    preimage: 'ff',
  }));
  // Fast verification loop for fake timers
  (svc as unknown as Record<string, unknown>).verifyIntervalMs = 1000;
  return svc;
}

function capture<T>(event: 'zap:pending' | 'zap:succeeded' | 'zap:failed') {
  const events: T[] = [];
  const id = TypedEventBus.getInstance().on(event, (payload: T) =>
    events.push(payload)
  );
  return { events, stop: () => TypedEventBus.getInstance().off(id) };
}

function userZaps(): Record<string, number> {
  return (
    (perAccountStore._map.get('user_zaps') as Record<string, number>) ?? {}
  );
}

const REQUEST = {
  noteId: NOTE,
  authorPubkey: AUTHOR,
  amount: 50,
  comment: 'Great post!',
};

describe('Zap payment lifecycle (wallet-side success criterion)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    perAccountStore._map.clear();
    nwcMock.isConnected.mockReturnValue(true);
    nwcMock.payInvoice.mockReset();
    nwcMock.lookupInvoice.mockReset();
    nwcMock.lookupInvoice.mockResolvedValue('unknown');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('immediate NWC success: emits zap:succeeded once, entry permanent, USER_ZAPS stored', async () => {
    const svc = newService();
    const succeeded = capture('zap:succeeded');
    const pending = capture('zap:pending');
    nwcMock.payInvoice.mockResolvedValue({
      success: true,
      preimage: 'ff'.repeat(32),
    });

    const result = await svc.sendZap(REQUEST);

    expect(result.success).toBe(true);
    expect(succeeded.events).toHaveLength(1);
    expect(succeeded.events[0]).toEqual({
      noteId: NOTE,
      invoice: INVOICE,
      amount: 50,
    });
    expect(pending.events).toHaveLength(0);
    expect(svc.getZapPendingStates(NOTE)).toHaveLength(1);
    expect(svc.getZapPendingStates(NOTE)[0].state).toBe('succeeded');
    expect(svc.getZapPendingStates(NOTE)[0].comment).toBe('Great post!');
    expect(svc.getUnconfirmedZapAmount(NOTE)).toBe(50);
    expect(userZaps()[NOTE]).toBe(50);
    expect(nwcMock.lookupInvoice).not.toHaveBeenCalled();
    succeeded.stop();
    pending.stop();
  });

  it('definitive NWC error: no optimistic state, no lifecycle events, USER_ZAPS untouched', async () => {
    const svc = newService();
    const pending = capture('zap:pending');
    const failed = capture('zap:failed');
    nwcMock.payInvoice.mockResolvedValue({
      success: false,
      error: 'Insufficient balance',
      definitive: true,
    });

    const result = await svc.sendZap(REQUEST);

    expect(result.success).toBe(false);
    expect(pending.events).toHaveLength(0);
    expect(failed.events).toHaveLength(0);
    expect(svc.getZapPendingStates(NOTE)).toHaveLength(0);
    expect(userZaps()[NOTE]).toBeUndefined();
    pending.stop();
    failed.stop();
  });

  it('ambiguous NWC timeout: emits zap:pending, entry verifying, optimistic result', async () => {
    const svc = newService();
    const pending = capture('zap:pending');
    nwcMock.payInvoice.mockRejectedValue(new Error('NWC request timeout'));

    const result = await svc.sendZap(REQUEST);

    expect(result.success).toBe(true);
    expect(pending.events).toHaveLength(1);
    expect(pending.events[0]).toEqual({
      noteId: NOTE,
      invoice: INVOICE,
      amount: 50,
    });
    expect(svc.getZapPendingStates(NOTE)[0].state).toBe('verifying');
    expect(userZaps()[NOTE]).toBe(50);
    pending.stop();
  });

  it('ambiguous then wallet says paid: zap:succeeded emitted, entry succeeds', async () => {
    const svc = newService();
    const succeeded = capture('zap:succeeded');
    const failed = capture('zap:failed');
    nwcMock.payInvoice.mockRejectedValue(new Error('NWC request timeout'));
    nwcMock.lookupInvoice.mockResolvedValue('paid');

    await svc.sendZap(REQUEST);
    await vi.advanceTimersByTimeAsync(1000);

    expect(succeeded.events).toHaveLength(1);
    expect(failed.events).toHaveLength(0);
    expect(svc.getZapPendingStates(NOTE)[0].state).toBe('succeeded');
    expect(userZaps()[NOTE]).toBe(50);
    succeeded.stop();
    failed.stop();
  });

  it('ambiguous then wallet says unpaid: zap:failed + full revert (entry + USER_ZAPS removed)', async () => {
    const svc = newService();
    const failed = capture('zap:failed');
    const succeeded = capture('zap:succeeded');
    nwcMock.payInvoice.mockRejectedValue(new Error('NWC request timeout'));
    nwcMock.lookupInvoice.mockResolvedValue('unpaid');

    await svc.sendZap(REQUEST);
    await vi.advanceTimersByTimeAsync(1000);

    expect(failed.events).toHaveLength(1);
    expect(failed.events[0]).toEqual({
      noteId: NOTE,
      invoice: INVOICE,
      amount: 50,
    });
    expect(succeeded.events).toHaveLength(0);
    expect(svc.getZapPendingStates(NOTE)).toHaveLength(0);
    expect(userZaps()[NOTE]).toBeUndefined();
    failed.stop();
    succeeded.stop();
  });

  it('wallet unreachable: stays verifying, keeps polling, never reverts', async () => {
    const svc = newService();
    const failed = capture('zap:failed');
    nwcMock.payInvoice.mockRejectedValue(new Error('NWC request timeout'));
    nwcMock.lookupInvoice.mockRejectedValue(new Error('wallet offline'));

    await svc.sendZap(REQUEST);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(nwcMock.lookupInvoice.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(svc.getZapPendingStates(NOTE)[0].state).toBe('verifying');
    expect(failed.events).toHaveLength(0);
    expect(userZaps()[NOTE]).toBe(50);
    failed.stop();
  });

  it('signature-verified receipt confirmation upgrades verifying → succeeded', async () => {
    const svc = newService();
    const succeeded = capture('zap:succeeded');
    nwcMock.payInvoice.mockRejectedValue(new Error('NWC request timeout'));
    nwcMock.lookupInvoice.mockResolvedValue('unknown');

    await svc.sendZap(REQUEST);
    expect(svc.getZapPendingStates(NOTE)[0].state).toBe('verifying');

    transportMock.deliverReceipt({
      id: 'r1',
      kind: 9735,
      tags: [
        ['bolt11', INVOICE],
        ['p', AUTHOR],
      ],
      content: '',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(succeeded.events).toHaveLength(1);
    expect(svc.getZapPendingStates(NOTE)[0].state).toBe('succeeded');
    succeeded.stop();
  });

  it('receipt confirmation after immediate success removes the entry (receipt-based stats take over)', async () => {
    const svc = newService();
    const succeeded = capture('zap:succeeded');
    nwcMock.payInvoice.mockResolvedValue({
      success: true,
      preimage: 'ff'.repeat(32),
    });

    await svc.sendZap(REQUEST);
    expect(svc.getUnconfirmedZapAmount(NOTE)).toBe(50);

    transportMock.deliverReceipt({
      id: 'r1',
      kind: 9735,
      tags: [['bolt11', INVOICE]],
      content: '',
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(succeeded.events).toHaveLength(1); // no duplicate emit
    expect(svc.getUnconfirmedZapAmount(NOTE)).toBe(0);
    expect(svc.getZapPendingStates(NOTE)).toHaveLength(0);
    succeeded.stop();
  });

  it('reconcileZapStates removes entries whose receipt is already in the fetched stats', async () => {
    const svc = newService();
    nwcMock.payInvoice.mockResolvedValue({
      success: true,
      preimage: 'ff'.repeat(32),
    });
    await svc.sendZap(REQUEST);
    expect(svc.getUnconfirmedZapAmount(NOTE)).toBe(50);

    svc.reconcileZapStates(NOTE, [
      {
        id: 'r1',
        kind: 9735,
        tags: [['bolt11', INVOICE]],
        content: '',
      } as never,
    ]);

    expect(svc.getUnconfirmedZapAmount(NOTE)).toBe(0);
    expect(svc.getZapPendingStates(NOTE)).toHaveLength(0);
  });

  it('multiple pending zaps on the same note sum up; other notes stay isolated', async () => {
    const svc = newService();
    nwcMock.payInvoice.mockRejectedValue(new Error('NWC request timeout'));
    (svc as unknown as Record<string, AnyFn>).fetchInvoice = vi
      .fn()
      .mockImplementationOnce(async () => INVOICE)
      .mockImplementationOnce(async () => INVOICE2)
      .mockImplementationOnce(async () => INVOICE3);

    await svc.sendZap(REQUEST);
    await vi.advanceTimersByTimeAsync(3001); // clear the 3s zap debounce
    await svc.sendZap({ ...REQUEST, amount: 21 });
    await vi.advanceTimersByTimeAsync(3001);
    await svc.sendZap({ ...REQUEST, noteId: NOTE2, amount: 7 });

    expect(svc.getUnconfirmedZapAmount(NOTE)).toBe(71);
    expect(svc.getUnconfirmedZapAmount(NOTE2)).toBe(7);
    expect(svc.getZapPendingStates(NOTE)).toHaveLength(2);
  });

  it('clearPendingZaps wipes all lifecycle state (account switch)', async () => {
    const svc = newService();
    nwcMock.payInvoice.mockResolvedValue({
      success: true,
      preimage: 'ff'.repeat(32),
    });
    await svc.sendZap(REQUEST);
    expect(svc.getUnconfirmedZapAmount(NOTE)).toBe(50);

    svc.clearPendingZaps();

    expect(svc.getUnconfirmedZapAmount(NOTE)).toBe(0);
    expect(svc.getZapPendingStates(NOTE)).toHaveLength(0);
  });

  it('WebLN success: zap:succeeded without NWC verification loop', async () => {
    const svc = newService();
    const pending = capture('zap:pending');
    nwcMock.isConnected.mockReturnValue(false);

    const result = await svc.sendZap(REQUEST);

    expect(result.success).toBe(true);
    expect(pending.events).toHaveLength(0);
    expect(svc.getZapPendingStates(NOTE)[0].state).toBe('succeeded');
    expect(nwcMock.lookupInvoice).not.toHaveBeenCalled();
    pending.stop();
  });
});
