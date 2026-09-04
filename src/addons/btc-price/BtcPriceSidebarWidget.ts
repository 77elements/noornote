/**
 * BtcPriceSidebarWidget - "1 BTC = 67.398 €" rate line, styled by the shared
 * `.sidebar-widget` classes (same chrome as the Nostr-Majlis prayer widget).
 *
 * Used twice: the static sidebar slot (`[data-sidebar-widget="btc-price"]`,
 * visibility governed by the "Show BTC Sidebar Widget" setting) and the addon
 * page's content zone. Fetches via ExchangeRateService (CoinGecko → Kraken →
 * static fallback, 20-min cache) every 5 minutes and follows the shared fiat
 * currency setting (Zaps / Wallet Balance / here) via the
 * 'fiat-currency-changed' window event.
 */

import { ExchangeRateService } from '../../services/ExchangeRateService';
import { KeychainStorage } from '../../services/KeychainStorage';
import { escapeHtml } from '../../helpers/escapeHtml';

export interface BtcPriceWidgetOptions {
  /** Lazily resolve the mount element (the sidebar slot may not exist yet). */
  container: () => HTMLElement | null;
  /** Whether the widget should currently be shown; re-evaluated on refresh(). */
  visible: () => boolean;
}

const UPDATE_INTERVAL_MS = 5 * 60_000;

export class BtcPriceSidebarWidget {
  private el: HTMLElement | null = null;
  private timer: number | null = null;
  private currency = 'EUR';
  private currencyLoaded = false;
  private updating = false;

  private onFiatCurrencyChanged = (e: Event): void => {
    const currency = (e as CustomEvent<{ currency?: string }>).detail?.currency;
    if (!currency) return;
    this.currency = currency;
    this.currencyLoaded = true;
    void this.update();
  };

  constructor(private opts: BtcPriceWidgetOptions) {}

  mount(): void {
    window.addEventListener(
      'fiat-currency-changed',
      this.onFiatCurrencyChanged
    );
    this.refresh();
  }

  /** Re-evaluate visibility: render + start the refresh timer, or tear down. */
  refresh(): void {
    if (!this.opts.visible()) {
      this.teardown();
      return;
    }
    if (!this.el) {
      const container = this.opts.container();
      if (!container) return;
      this.el = document.createElement('div');
      this.el.className = 'sidebar-widget';
      container.appendChild(this.el);
      this.el.innerHTML =
        '<div class="sidebar-widget__empty pulsate">Loading…</div>';
    }
    void this.update();
    if (this.timer === null)
      this.timer = window.setInterval(
        () => void this.update(),
        UPDATE_INTERVAL_MS
      );
  }

  private async update(): Promise<void> {
    if (!this.el || this.updating) return;
    this.updating = true;
    try {
      if (!this.currencyLoaded) {
        const stored = await KeychainStorage.loadFiatCurrency();
        if (stored) this.currency = stored;
        this.currencyLoaded = true;
      }
      const svc = ExchangeRateService.getInstance();
      const rate = await svc.getRate(this.currency);
      if (!this.el) return; // torn down mid-fetch
      if (rate === null) {
        this.el.innerHTML =
          '<div class="sidebar-widget__empty">Price unavailable</div>';
        return;
      }
      const amount = svc.formatAmount(rate, this.currency, 0);
      const symbol = escapeHtml(svc.getCurrencySymbol(this.currency));
      this.el.innerHTML = `
        <div class="sidebar-widget__row sidebar-widget__row--pair sidebar-widget__vals">
          <span class="sidebar-widget__label">1 BTC</span>
          <span>${amount} ${symbol}</span>
        </div>`;
    } finally {
      this.updating = false;
    }
  }

  private teardown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.el?.remove();
    this.el = null;
    this.updating = false;
  }

  destroy(): void {
    window.removeEventListener(
      'fiat-currency-changed',
      this.onFiatCurrencyChanged
    );
    this.teardown();
  }
}
