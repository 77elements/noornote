/**
 * Exchange Rate Service
 * Fetches and caches BTC exchange rates for fiat currencies
 *
 * Source cascade (Kraken-first):
 *  1. Kraken public ticker — primary. No API key, reliable, covers the
 *     major currencies (EUR, USD, GBP, JPY, CHF, CAD, AUD).
 *  2. CoinGecko — on demand only: queried when the requested currency is
 *     one Kraken does not serve (CNY, SAR, NZD, AED, ZAR) or when Kraken
 *     failed to deliver. Keeps anonymous CoinGecko traffic (and its
 *     intermittent rate limiting) out of the common path.
 *  3. Static fallback rates — last resort for offline/blocked sources.
 */

/** Fiat currencies NoorNote quotes BTC prices in (CoinGecko vs_currencies). */
export type SupportedCurrency =
  | 'EUR'
  | 'USD'
  | 'GBP'
  | 'JPY'
  | 'CNY'
  | 'AUD'
  | 'CHF'
  | 'SAR'
  | 'CAD'
  | 'NZD'
  | 'AED'
  | 'ZAR';

export class ExchangeRateService {
  private static instance: ExchangeRateService;
  private rates: Map<string, number> = new Map();
  private lastFetch: number = 0;
  private readonly CACHE_DURATION = 20 * 60 * 1000; // 20 minutes

  /** Currencies the Kraken public ticker serves live (see fetchKrakenRates). */
  private static readonly KRAKEN_CURRENCIES: ReadonlySet<string> = new Set([
    'EUR',
    'USD',
    'GBP',
    'JPY',
    'CHF',
    'CAD',
    'AUD',
  ]);

  /** Approximate static rates (fiat per BTC) — last resort for offline/blocked sources. */
  private static readonly STATIC_FALLBACK_RATES: Record<string, number> = {
    EUR: 95000,
    USD: 100000,
    GBP: 80000,
    JPY: 14000000,
    CNY: 700000,
    AUD: 150000,
    CHF: 90000,
    SAR: 375000,
    CAD: 135000,
    NZD: 165000,
    AED: 367000,
    ZAR: 1750000,
  };

  private constructor() {}

  public static getInstance(): ExchangeRateService {
    if (!ExchangeRateService.instance) {
      ExchangeRateService.instance = new ExchangeRateService();
    }
    return ExchangeRateService.instance;
  }

  /**
   * Get BTC exchange rate for a fiat currency
   */
  public async getRate(currency: string): Promise<number | null> {
    // Check cache
    const now = Date.now();
    if (
      this.rates.has(currency) &&
      now - this.lastFetch < this.CACHE_DURATION
    ) {
      return this.rates.get(currency) || null;
    }

    // Fetch fresh rates
    await this.fetchRates(currency);
    return this.rates.get(currency) || null;
  }

  /**
   * Bypass the 20-min cache and fetch fresh rates now (manual refresh).
   * Delivered rates are overwritten; undelivered ones keep their last value.
   */
  public async forceRefresh(currency: string): Promise<number | null> {
    this.lastFetch = 0;
    return this.getRate(currency);
  }

  /** Fetch fresh rates: Kraken first, CoinGecko only where needed, static as last resort. */
  private async fetchRates(requestedCurrency: string): Promise<void> {
    // Primary: Kraken public ticker (majors).
    try {
      await this.fetchKrakenRates();
    } catch (error) {
      console.error('Failed to fetch Kraken rates:', error);
    }

    // CoinGecko only when Kraken cannot satisfy the request: either the
    // requested currency is not a Kraken pair, or Kraken failed to deliver it.
    const krakenSatisfies =
      ExchangeRateService.KRAKEN_CURRENCIES.has(requestedCurrency) &&
      this.rates.has(requestedCurrency);
    if (!krakenSatisfies) {
      try {
        await this.fetchCoinGeckoRates();
      } catch (error) {
        console.error('Failed to fetch exchange rates:', error);
      }
    }

    // Guarantee usable rates: without a rate for the requested currency (and
    // EUR/USD) the wallet renders "<0,01 €" for every balance (rate missing →
    // convertSatsToFiat → 0). Static fallbacks fill only what the live
    // sources left blank — live rates are never overwritten.
    if (!this.rates.has(requestedCurrency)) {
      const fallback =
        ExchangeRateService.STATIC_FALLBACK_RATES[requestedCurrency];
      if (fallback !== undefined) this.rates.set(requestedCurrency, fallback);
    }
    for (const cur of ['EUR', 'USD']) {
      if (!this.rates.has(cur)) {
        this.rates.set(cur, ExchangeRateService.STATIC_FALLBACK_RATES[cur]!);
      }
    }
    this.lastFetch = Date.now();
  }

  /**
   * CoinGecko simple/price — all 12 currencies in one request, no API key
   * (rate-limits anonymous browser clients intermittently, hence secondary).
   */
  private async fetchCoinGeckoRates(): Promise<void> {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur,usd,gbp,jpy,cny,aud,chf,sar,cad,nzd,aed,zar'
    );

    if (!response.ok) {
      throw new Error('Failed to fetch exchange rates');
    }

    // CoinGecko simple/price shape: { bitcoin: { <currency>: <rate>, … } }.
    // Third-party response — validate before trusting the numbers.
    const data = (await response.json()) as {
      bitcoin?: Partial<Record<SupportedCurrency, number>>;
    };
    const btcRates = data.bitcoin;
    if (!btcRates) {
      throw new Error('Exchange rate response missing bitcoin object');
    }

    // Store rates (12 currencies) — skip any the API didn't return. Response
    // keys are lowercase (vs_currencies), internal keys are uppercase codes —
    // uppercase them or lookups like getRate('SAR') never match.
    const entries = Object.entries(btcRates) as [string, number | undefined][];
    for (const [cur, rate] of entries) {
      if (typeof rate === 'number' && Number.isFinite(rate)) {
        this.rates.set(cur.toUpperCase(), rate);
      }
    }
  }

  /** Kraken public ticker — BTC/fiat last prices, no API key required. */
  private async fetchKrakenRates(): Promise<void> {
    const response = await fetch(
      'https://api.kraken.com/0/public/Ticker?pair=XXBTZEUR,XXBTZUSD,XBTGBP,XBTJPY,XBTCHF,XBTCAD,XBTAUD'
    );
    if (!response.ok) {
      throw new Error('Failed to fetch Kraken rates');
    }
    const data = (await response.json()) as {
      result?: Record<string, { c?: [string | undefined, string | undefined] }>;
    };
    const result = data.result;
    if (!result) {
      throw new Error('Kraken response missing result object');
    }
    const pairs: Record<string, SupportedCurrency> = {
      XXBTZEUR: 'EUR',
      XXBTZUSD: 'USD',
      XBTGBP: 'GBP',
      XBTJPY: 'JPY',
      XBTCHF: 'CHF',
      XBTCAD: 'CAD',
      XBTAUD: 'AUD',
    };
    for (const [pair, currency] of Object.entries(pairs)) {
      const price = parseFloat(result[pair]?.c?.[0] ?? '');
      if (Number.isFinite(price) && price > 0) {
        this.rates.set(currency, price);
      }
    }
  }

  /**
   * Convert sats to fiat currency
   */
  public async convertSatsToFiat(
    sats: number,
    currency: string
  ): Promise<number> {
    const rate = await this.getRate(currency);
    if (!rate) return 0;

    // 1 BTC = 100,000,000 sats
    const btc = sats / 100000000;
    return btc * rate;
  }

  /**
   * Get currency symbol
   */
  public getCurrencySymbol(currency: string): string {
    const symbols: { [key: string]: string } = {
      EUR: '€',
      USD: '$',
      GBP: '£',
      JPY: '¥',
      CNY: '¥',
      AUD: 'A$',
      CHF: 'CHF',
      SAR: 'SR',
      CAD: 'C$',
      NZD: 'NZ$',
      AED: 'AED',
      ZAR: 'R',
    };
    return symbols[currency] || currency;
  }

  /**
   * Get locale for currency
   */
  private getLocale(currency: string): string {
    const locales: { [key: string]: string } = {
      EUR: 'de-DE', // Komma
      USD: 'en-US', // Punkt
      GBP: 'en-GB', // Punkt
      JPY: 'ja-JP', // keine Dezimalstellen
      CNY: 'zh-CN', // Punkt
      AUD: 'en-AU', // Punkt
      CHF: 'de-CH', // Komma
      SAR: 'ar-SA', // Punkt
      CAD: 'en-CA', // Punkt
      NZD: 'en-NZ', // Punkt
      AED: 'ar-AE', // Punkt
      ZAR: 'en-ZA', // Punkt
    };
    return locales[currency] || 'en-US';
  }

  /**
   * Format amount with locale-specific decimal separator
   */
  public formatAmount(
    amount: number,
    currency: string,
    decimals?: number
  ): string {
    const locale = this.getLocale(currency);
    const d = decimals ?? (currency === 'JPY' ? 0 : 2);
    return amount.toLocaleString(locale, {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  }

  /**
   * Get all available currencies
   */
  public getAvailableCurrencies(): Array<{
    code: string;
    name: string;
    symbol: string;
  }> {
    return [
      { code: 'EUR', name: 'Euro', symbol: '€' },
      { code: 'USD', name: 'US Dollar', symbol: '$' },
      { code: 'GBP', name: 'British Pound', symbol: '£' },
      { code: 'JPY', name: 'Japanese Yen', symbol: '¥' },
      { code: 'CNY', name: 'Chinese Yuan', symbol: '¥' },
      { code: 'AUD', name: 'Australian Dollar', symbol: 'A$' },
      { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF' },
      { code: 'SAR', name: 'Saudi Riyal', symbol: 'SR' },
      { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$' },
      { code: 'NZD', name: 'New Zealand Dollar', symbol: 'NZ$' },
      { code: 'AED', name: 'UAE Dirham', symbol: 'AED' },
      { code: 'ZAR', name: 'South African Rand', symbol: 'R' },
    ];
  }
}
