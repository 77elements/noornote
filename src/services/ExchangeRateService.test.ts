/**
 * ExchangeRateService — source cascade tests (Kraken-first restructure).
 *
 * Kraken is the primary source for its majors; CoinGecko is only queried
 * when the requested currency is NOT a Kraken pair or Kraken failed to
 * deliver it; static fallbacks fill whatever is still missing.
 * forceRefresh bypasses the 20-min cache.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Record every fetch URL so tests can assert who was (not) called. */
const calls: string[] = [];

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function krakenBody(eur: number, usd: number): unknown {
  return {
    error: [],
    result: {
      XXBTZEUR: { c: [String(eur), '1.0'] },
      XXBTZUSD: { c: [String(usd), '1.0'] },
    },
  };
}

/** Fresh singleton per test: reset modules so the static `instance` is new. */
async function freshService() {
  const mod = await import('./ExchangeRateService');
  return mod.ExchangeRateService;
}

describe('ExchangeRateService — Kraken-first source cascade', () => {
  beforeEach(() => {
    vi.resetModules();
    calls.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Kraken serves a major → CoinGecko is never called', async () => {
    const Service = await freshService();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('api.kraken.com'))
          return okJson(krakenBody(67777.8, 78379.2));
        return new Response('rate limited', { status: 429 });
      })
    );
    const rate = await Service.getInstance().getRate('EUR');
    expect(rate).toBe(67777.8);
    expect(calls.some(c => c.includes('api.kraken.com'))).toBe(true);
    expect(calls.some(c => c.includes('api.coingecko.com'))).toBe(false);
  });

  it('exotic currency (SAR) → CoinGecko is queried and fills it', async () => {
    const Service = await freshService();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('api.kraken.com'))
          return okJson(krakenBody(67777.8, 78379.2));
        if (url.includes('api.coingecko.com'))
          return okJson({ bitcoin: { sar: 375123, eur: 67000, usd: 78000 } });
        return new Response('not found', { status: 404 });
      })
    );
    const rate = await Service.getInstance().getRate('SAR');
    expect(rate).toBe(375123);
  });

  it('Kraken down → CoinGecko serves the majors as fallback', async () => {
    const Service = await freshService();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('api.kraken.com'))
          return new Response('nope', { status: 500 });
        if (url.includes('api.coingecko.com'))
          return okJson({ bitcoin: { eur: 66111, usd: 77111 } });
        return new Response('not found', { status: 404 });
      })
    );
    const rate = await Service.getInstance().getRate('EUR');
    expect(rate).toBe(66111);
  });

  it('both sources fail → static fallback rate, never null', async () => {
    const Service = await freshService();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 }))
    );
    const rate = await Service.getInstance().getRate('EUR');
    expect(rate).toBe(95000);
  });

  it('cached rate within 20 min → no second fetch', async () => {
    const Service = await freshService();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('api.kraken.com'))
          return okJson(krakenBody(67777.8, 78379.2));
        return new Response('rate limited', { status: 429 });
      })
    );
    const svc = Service.getInstance();
    await svc.getRate('EUR');
    await svc.getRate('EUR');
    expect(calls.filter(c => c.includes('api.kraken.com'))).toHaveLength(1);
  });

  it('forceRefresh bypasses the cache and picks up the new rate', async () => {
    const Service = await freshService();
    const krakenRates = [67777.8, 68000];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('api.kraken.com')) {
          const eur = krakenRates.shift();
          return okJson(krakenBody(eur ?? 0, 78379.2));
        }
        return new Response('rate limited', { status: 429 });
      })
    );
    const svc = Service.getInstance();
    expect(await svc.getRate('EUR')).toBe(67777.8);
    expect(await svc.forceRefresh('EUR')).toBe(68000);
    expect(calls.filter(c => c.includes('api.kraken.com'))).toHaveLength(2);
  });
});
