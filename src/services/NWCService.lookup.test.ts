/**
 * TDD tests for NWCService.lookupInvoice — the wallet-side verification of
 * ambiguous zap payments (NIP-47 lookup_invoice, list_transactions fallback).
 *
 * Decision contract:
 *   'paid'    — settled (preimage / settled_at / state 'settled')
 *   'unpaid'  — ONLY the explicit NOT_FOUND error code (wallet does not know
 *               the invoice as paid → sats did not leave the wallet)
 *   'unknown' — everything else: unreachable, unsupported (→ transaction-scan
 *               fallback), pending, missing fields. NEVER a false 'unpaid'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { nwcRequestMock, listTransactionsMock } = vi.hoisted(() => ({
  nwcRequestMock: vi.fn(),
  listTransactionsMock: vi.fn(),
}));

vi.mock('./SystemLogger', () => ({
  SystemLogger: {
    getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));
vi.mock('./AuthService', () => ({
  AuthService: {
    getInstance: () => ({ getCurrentUser: () => ({ pubkey: 'a'.repeat(64) }) }),
  },
}));
vi.mock('./PerAccountLocalStorage', () => ({
  PerAccountLocalStorage: {
    getInstance: () => ({ get: () => null, set: vi.fn() }),
  },
}));

import { NWCService, parseLookupInvoiceResponse } from './NWCService';

function newService(): NWCService {
  (NWCService as unknown as { instance: NWCService | null }).instance = null;
  const svc = NWCService.getInstance();
  // Wire internals for deterministic verification (no real relay/WebSocket):
  (svc as unknown as Record<string, unknown>).getConnectionForCurrentUser =
    () => ({
      secret: '00'.repeat(32),
      walletPubkey: 'b'.repeat(64),
      relay: 'wss://nwc.test',
    });
  (svc as unknown as Record<string, unknown>).executeNwcRequest =
    nwcRequestMock;
  (svc as unknown as Record<string, unknown>).listTransactions =
    listTransactionsMock;
  return svc;
}

describe('parseLookupInvoiceResponse (pure)', () => {
  it('null result → unknown', () => {
    expect(parseLookupInvoiceResponse(null)).toBe('unknown');
  });

  it('preimage present → paid', () => {
    expect(parseLookupInvoiceResponse({ preimage: 'ff'.repeat(32) })).toBe(
      'paid'
    );
  });

  it('transaction settled_at → paid', () => {
    expect(
      parseLookupInvoiceResponse({
        transaction: { settled_at: 1756000000 },
      })
    ).toBe('paid');
  });

  it('top-level settled_at → paid', () => {
    expect(parseLookupInvoiceResponse({ settled_at: 1756000000 })).toBe('paid');
  });

  it("transaction state 'settled' → paid", () => {
    expect(
      parseLookupInvoiceResponse({ transaction: { state: 'settled' } })
    ).toBe('paid');
  });

  it('pending transaction (no settled_at) → unknown', () => {
    expect(parseLookupInvoiceResponse({ transaction: {} })).toBe('unknown');
  });

  it('empty result → unknown', () => {
    expect(parseLookupInvoiceResponse({})).toBe('unknown');
  });
});

describe('lookupInvoice (service)', () => {
  beforeEach(() => {
    nwcRequestMock.mockReset();
    listTransactionsMock.mockReset();
    listTransactionsMock.mockResolvedValue([]);
  });

  it('NOT_FOUND error → unpaid (only conclusive unpaid signal)', async () => {
    const svc = newService();
    nwcRequestMock.mockResolvedValue({
      error: { code: 'NOT_FOUND', message: 'Unknown invoice' },
    });
    await expect(svc.lookupInvoice('lnbc1test')).resolves.toBe('unpaid');
  });

  it('settled transaction result → paid', async () => {
    const svc = newService();
    nwcRequestMock.mockResolvedValue({
      result: { transaction: { settled_at: 1756000000 } },
    });
    await expect(svc.lookupInvoice('lnbc1test')).resolves.toBe('paid');
  });

  it('wallet unreachable (throws) → unknown, never unpaid', async () => {
    const svc = newService();
    nwcRequestMock.mockRejectedValue(new Error('relay offline'));
    await expect(svc.lookupInvoice('lnbc1test')).resolves.toBe('unknown');
  });

  it('other error codes → unknown', async () => {
    const svc = newService();
    nwcRequestMock.mockResolvedValue({
      error: { code: 'INTERNAL', message: 'boom' },
    });
    await expect(svc.lookupInvoice('lnbc1test')).resolves.toBe('unknown');
  });

  it('NOT_SUPPORTED → list_transactions fallback finds settled outgoing invoice → paid', async () => {
    const svc = newService();
    nwcRequestMock.mockResolvedValue({
      error: { code: 'NOT_SUPPORTED', message: 'Unsupported method' },
    });
    listTransactionsMock.mockResolvedValue([
      {
        type: 'outgoing',
        invoice: 'lnbc1test',
        payment_hash: 'ab'.repeat(32),
        amount: 50000,
        settled_at: 1756000000,
      },
    ]);
    await expect(svc.lookupInvoice('lnbc1test')).resolves.toBe('paid');
  });

  it('NOT_SUPPORTED + invoice absent from transactions → unknown (absence is not conclusive)', async () => {
    const svc = newService();
    nwcRequestMock.mockResolvedValue({
      error: { code: 'NOT_SUPPORTED', message: 'Unsupported method' },
    });
    listTransactionsMock.mockResolvedValue([]);
    await expect(svc.lookupInvoice('lnbc1test')).resolves.toBe('unknown');
  });
});
