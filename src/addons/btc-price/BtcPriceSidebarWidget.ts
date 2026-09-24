/**
 * BtcPriceSidebarWidget - "1 BTC = 67.398 €" rate line with manual refresh,
 * styled by the shared `.sidebar-widget` classes (same chrome as the
 * Nostr-Majlis prayer widget).
 *
 * Used twice: the static sidebar slot (`[data-sidebar-widget="btc-price"]`,
 * visibility governed by the "Show BTC Sidebar Widget" setting) and the addon
 * page's content zone. Auto-updates via ExchangeRateService (Kraken-first,
 * 20-min cache) every 5 minutes, follows the shared fiat currency setting
 * (Zaps / Wallet Balance / here) via the 'fiat-currency-changed' window
 * event, and offers a manual refresh button (10s cooldown, no parallel
 * fetches) so the current rate is always one click away.
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
/** Cooldown for the manual refresh button — protects the public APIs from spam. */
const REFRESH_COOLDOWN_MS = 10_000;

export class BtcPriceSidebarWidget {
  private el: HTMLElement | null = null;
  private timer: number | null = null;
  private currency = 'EUR';
  private currencyLoaded = false;
  private updating = false;
  /** True only while a MANUAL refresh fetch is in flight (drives pulsate/disabled). */
  private manualBusy = false;
  private lastManualRefresh = 0;
  private unlockTimer: number | null = null;

  private onFiatCurrencyChanged = (e: Event): void => {
    const currency = (e as CustomEvent<{ currency?: string }>).detail?.currency;
    if (!currency) return;
    this.currency = currency;
    this.currencyLoaded = true;
    void this.update();
  };

  // Delegated so it survives the innerHTML rewrites in renderRate(); removed in teardown().
  private onClick = (e: MouseEvent): void => {
    if (
      (e.target as HTMLElement | null)?.closest('[data-action="btc-refresh"]')
    ) {
      e.preventDefault();
      void this.manualRefresh();
    }
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
      this.el.addEventListener('click', this.onClick);
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
      const rate = await ExchangeRateService.getInstance().getRate(
        this.currency
      );
      this.renderRate(rate);
    } finally {
      this.updating = false;
    }
  }

  /** Manual refresh: bypass the rate cache, guarded by the updating flag + cooldown. */
  private async manualRefresh(): Promise<void> {
    if (!this.el || this.updating || this.isRefreshLocked()) return;
    this.lastManualRefresh = Date.now();
    this.manualBusy = true;
    this.updating = true;
    this.syncRefreshButton();
    try {
      const rate = await ExchangeRateService.getInstance().forceRefresh(
        this.currency
      );
      this.renderRate(rate);
    } finally {
      this.manualBusy = false;
      this.updating = false;
      this.syncRefreshButton();
    }
  }
  /** A refresh click is blocked while a manual fetch runs or the cooldown is active. */
  private isRefreshLocked(): boolean {
    return (
      this.manualBusy ||
      Date.now() - this.lastManualRefresh < REFRESH_COOLDOWN_MS
    );
  }
  /**
   * Mirror the lock state onto the button: disabled + grey while a manual
   * fetch is running or the cooldown is active, pulsating while it runs.
   * Background updates (initial load, 5-min interval) never touch the button —
   * they run invisibly and leave it clickable. A timer silently re-enables
   * the button when the cooldown expires — nothing below the widget shifts.
   */
  private syncRefreshButton(): void {
    const btn = this.el?.querySelector<HTMLButtonElement>(
      '[data-action="btc-refresh"]'
    );
    if (!btn) return;
    const locked = this.isRefreshLocked();
    btn.disabled = locked;
    btn.classList.toggle('pulsate', this.manualBusy);
    if (
      locked &&
      this.unlockTimer === null &&
      Date.now() - this.lastManualRefresh < REFRESH_COOLDOWN_MS
    ) {
      const wait = Math.max(
        0,
        this.lastManualRefresh + REFRESH_COOLDOWN_MS - Date.now()
      );
      this.unlockTimer = window.setTimeout(() => {
        this.unlockTimer = null;
        this.syncRefreshButton();
      }, wait);
    }
  }

  private renderRate(rate: number | null): void {
    if (!this.el) return; // torn down mid-fetch
    if (rate === null) {
      this.el.innerHTML =
        '<div class="sidebar-widget__empty">Price unavailable</div>';
      return;
    }
    const svc = ExchangeRateService.getInstance();
    const amount = svc.formatAmount(rate, this.currency, 0);
    const symbol = escapeHtml(svc.getCurrencySymbol(this.currency));
    this.el.innerHTML = `
      <div class="sidebar-widget__cols">
        <span class="sidebar-widget__label">1 BTC</span>
        <span>${amount} ${symbol}</span>
        <button type="button" class="sidebar-widget__refresh" data-action="btc-refresh" title="Refresh rate" aria-label="Refresh rate"${this.isRefreshLocked() ? ' disabled' : ''}><svg><use href="#icon-sync"/></svg></button>
      </div>`;
    this.syncRefreshButton();
  }

  private teardown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.unlockTimer !== null) {
      clearTimeout(this.unlockTimer);
      this.unlockTimer = null;
    }
    this.el?.removeEventListener('click', this.onClick);
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
