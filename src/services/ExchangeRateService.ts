/**
 * Exchange Rate Service
 * Fetches and caches BTC exchange rates for fiat currencies
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
    await this.fetchRates();
    return this.rates.get(currency) || null;
  }

  /**
   * Fetch all exchange rates from API
   */
  private async fetchRates(): Promise<void> {
    try {
      // Use CoinGecko API (free, no API key required)
      // 12 currencies: 2 strongest per continent
      // Europe: EUR, GBP | Americas: USD, CAD | Asia: JPY, CNY |
      // Oceania: AUD, NZD | Middle East: SAR, AED | Africa: ZAR, NGN
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

      // Store rates (12 currencies) — skip any the API didn't return
      for (const [cur, rate] of Object.entries(btcRates) as [
        SupportedCurrency,
        number | undefined,
      ][]) {
        if (typeof rate === 'number' && Number.isFinite(rate)) {
          this.rates.set(cur, rate);
        }
      }

      this.lastFetch = Date.now();
    } catch (error) {
      console.error('Failed to fetch exchange rates:', error);
      // Set fallback rates (approximate)
      if (this.rates.size === 0) {
        this.rates.set('EUR', 95000);
        this.rates.set('USD', 100000);
        this.rates.set('GBP', 80000);
        this.rates.set('JPY', 14000000);
        this.rates.set('CNY', 700000);
        this.rates.set('AUD', 150000);
        this.rates.set('CHF', 90000);
        this.rates.set('SAR', 375000);
        this.rates.set('CAD', 135000);
        this.rates.set('NZD', 165000);
        this.rates.set('AED', 367000);
        this.rates.set('ZAR', 1750000);
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
