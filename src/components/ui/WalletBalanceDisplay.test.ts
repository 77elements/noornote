// @vitest-environment jsdom
/**
 * Tests for WalletBalanceDisplay — the user-facing contract: BOTH values are
 * shown, the sats amount and the fiat conversion in the SELECTED currency
 * (docs: wallet fiat conversion fix, 2026-08-30).
 *
 * ExchangeRateService is real, but its network sources are stubbed: CoinGecko
 * fails (the intermittent rate-limit that broke the conversion) and Kraken
 * serves fixed rates — proving the fallback cascade ends in a usable rate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

vi.mock('../../services/NWCService', () => ({
  NWCService: {
    getInstance: () => ({
      isConnected: () => true,
      getBalance: vi.fn().mockResolvedValue(89_300_000), // 89,300 sats in msats
    }),
  },
}));

vi.mock('../../services/SystemLogger', () => ({
  SystemLogger: {
    getInstance: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock('../../services/KeychainStorage', () => ({
  KeychainStorage: {
    loadFiatCurrency: vi.fn().mockResolvedValue('USD'),
    saveFiatCurrency: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../services/PerAccountLocalStorage', () => ({
  PerAccountLocalStorage: {
    getInstance: () => ({
      get: (key: string, defaultValue: unknown) =>
        key === 'wallet_balance_visible' ? true : defaultValue,
      set: vi.fn(),
    }),
  },
  StorageKeys: {
    WALLET_BALANCE_VISIBLE: 'wallet_balance_visible',
    WALLET_BALANCE_LAST_MSATS: 'wallet_balance_last_msats',
  },
}));

import { WalletBalanceDisplay } from './WalletBalanceDisplay';

/** Route fetches: CoinGecko broken (the production bug), Kraken serving. */
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.coingecko.com')) {
        return new Response('rate limited', { status: 429 });
      }
      if (url.includes('api.kraken.com')) {
        return new Response(
          JSON.stringify({
            error: [],
            result: {
              XXBTZEUR: { c: ['67777.8', '1.0'] },
              XXBTZUSD: { c: ['78379.2', '1.0'] },
            },
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    })
  );
}

const read = (display: WalletBalanceDisplay) => {
  const el = display.getElement();
  return {
    sats: el.querySelector('.wallet-balance-amount')?.textContent ?? null,
    fiat: el.querySelector('.wallet-balance-fiat-amount')?.textContent ?? null,
  };
};

describe('WalletBalanceDisplay — sats and fiat values are both rendered', () => {
  beforeEach(() => {
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the sats amount and the fiat conversion in the selected currency', async () => {
    // KeychainStorage mock resolves USD → the fiat value must use Kraken USD
    const display = new WalletBalanceDisplay();
    await vi.waitFor(() => {
      expect(read(display).sats).toBe('89.3k'); // 89,300 sats → k format
    });
    await vi.waitFor(() => {
      expect(read(display).fiat).toBe('69.99 $'); // 89300/1e8 × 78379.2 USD/BTC
    });
    display.destroy();
  });

  it('switches the fiat value live when the currency preference changes', async () => {
    const display = new WalletBalanceDisplay();
    await vi.waitFor(() => {
      expect(read(display).fiat).toContain('$');
    });

    window.dispatchEvent(
      new CustomEvent('fiat-currency-changed', {
        detail: { currency: 'EUR' },
      })
    );

    await vi.waitFor(() => {
      expect(read(display).fiat).toBe('60,53 €'); // de-DE comma, Kraken EUR rate 67777.8
    });
    // sats value stays, formatted in the EUR locale now
    expect(read(display).sats).toBe('89,3k');
    display.destroy();
  });

  it('still shows the sats amount when no fiat rate is available at all', async () => {
    // Kill Kraken too — the static fallback path must still yield a number,
    // and the sats value must never be affected by rate problems.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 }))
    );
    const display = new WalletBalanceDisplay();
    await vi.waitFor(() => {
      expect(read(display).sats).toBe('89.3k'); // EUR locale fallback → de-DE? static test
    });
    const fiat = read(display).fiat ?? '';
    // fallback rate 100000 USD/BTC → 89300 sats = 89.30 USD; assert a real
    // number is rendered, never "<0,01" (the symptom of a missing rate)
    expect(fiat).not.toContain('<');
    expect(fiat).toMatch(/\d/);
    display.destroy();
  });

  it('shows the placeholder when there is no balance at all', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 }))
    );
    // Fresh storage WITHOUT cached msats: fake NWC returns null balance
    vi.doMock('../../services/NWCService', () => ({
      NWCService: {
        getInstance: () => ({
          isConnected: () => true,
          getBalance: vi.fn().mockResolvedValue(null),
        }),
      },
    }));
    const display = new WalletBalanceDisplay();
    const el = display.getElement();
    expect(el.querySelector('.wallet-balance-amount')?.textContent).toBe('--');
    expect(el.querySelector('.wallet-balance-fiat-amount')?.textContent).toBe(
      '--'
    );
    display.destroy();
    vi.doUnmock('../../services/NWCService');
    void (0 as unknown as NostrEvent);
  });
});
