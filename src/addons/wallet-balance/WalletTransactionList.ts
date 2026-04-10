/**
 * WalletTransactionList — Displays NWC transaction history with balance summary.
 *
 * Mounted into `data-addon-content="wallet-balance"` by WalletBalanceAddonView
 * when the addon toggle is ON. Uses `.ui-list` / `.ui-list__item` for rows.
 * Loads 20 transactions initially, more via InfiniteScroll (offset pagination).
 */

import { NWCService } from '../../services/NWCService';
import type { NWCTransaction } from '../../services/NWCService';
import { ExchangeRateService } from '../../services/ExchangeRateService';
import { KeychainStorage } from '../../services/KeychainStorage';
import { SystemLogger } from '../../components/system/SystemLogger';
import { InfiniteScroll } from '../../components/ui/InfiniteScroll';
import { escapeHtml } from '../../helpers/escapeHtml';
import satsIconUrl from '../../assets/sats.svg';

const PAGE_SIZE = 20;

export class WalletTransactionList {
  private element: HTMLElement;
  private listEl: HTMLElement | null = null;
  private nwcService: NWCService;
  private exchangeRateService: ExchangeRateService;
  private systemLogger: SystemLogger;
  private infiniteScroll: InfiniteScroll | null = null;
  private selectedCurrency = 'EUR';
  private destroyed = false;
  private loading = false;
  private offset = 0;
  private allLoaded = false;
  private onNwcRestored: () => void;

  constructor() {
    this.nwcService = NWCService.getInstance();
    this.exchangeRateService = ExchangeRateService.getInstance();
    this.systemLogger = SystemLogger.getInstance();

    this.element = document.createElement('div');
    this.element.className = 'wallet-tx-list';
    this.element.innerHTML = '<p class="wallet-tx-list__placeholder pulsate">Loading transactions…</p>';

    this.onNwcRestored = () => {
      this.offset = 0;
      this.allLoaded = false;
      void this.loadInitial();
    };
    window.addEventListener('nwc-connection-restored', this.onNwcRestored);

    void this.init();
  }

  private async init(): Promise<void> {
    await this.loadCurrency();
    await this.loadInitial();
  }

  private async loadCurrency(): Promise<void> {
    try {
      const c = await KeychainStorage.loadFiatCurrency();
      if (c) this.selectedCurrency = c;
    } catch { /* keep default */ }
  }

  private async loadInitial(): Promise<void> {
    if (this.destroyed) return;

    if (!this.nwcService.isConnected()) {
      this.element.innerHTML = '<p class="wallet-tx-list__placeholder">Wallet not connected</p>';
      return;
    }

    try {
      const [balanceMsats, transactions] = await Promise.all([
        this.nwcService.getBalance(),
        this.nwcService.listTransactions({ limit: PAGE_SIZE, offset: 0 }),
      ]);
      if (this.destroyed) return;

      this.offset = transactions.length;
      this.allLoaded = transactions.length < PAGE_SIZE;

      this.renderInitial(balanceMsats, transactions);
    } catch (err) {
      this.systemLogger.error('WalletTransactionList', 'Failed to load:', err);
      if (!this.destroyed) {
        this.element.innerHTML = '<p class="wallet-tx-list__placeholder">Failed to load transactions</p>';
      }
    }
  }

  private renderInitial(balanceMsats: number | null, transactions: NWCTransaction[]): void {
    const balanceSats = balanceMsats !== null ? Math.floor(balanceMsats / 1000) : null;

    // Balance summary
    let html = `<div class="wallet-tx-balance">`;
    if (balanceSats !== null) {
      html += `<span class="wallet-tx-balance__sats">${balanceSats.toLocaleString()}</span>`;
      html += ` <img src="${satsIconUrl}" class="wallet-tx-balance__sats-icon" alt="sats" />`;
    } else {
      html += `<span class="wallet-tx-balance__sats">--</span>`;
    }
    html += `</div>`;

    if (transactions.length === 0) {
      html += '<p class="wallet-tx-list__placeholder">No transactions yet</p>';
      this.element.innerHTML = html;
      return;
    }

    html += '<div class="ui-list" data-wallet-tx-list></div>';
    this.element.innerHTML = html;

    this.listEl = this.element.querySelector('[data-wallet-tx-list]');
    this.appendTransactions(transactions);

    // Fiat balance
    if (balanceSats !== null) {
      void this.fillFiatBalance(balanceSats);
    }

    // InfiniteScroll
    if (!this.allLoaded && this.listEl) {
      this.infiniteScroll = new InfiniteScroll(
        () => { void this.loadMore(); },
        { loadingMessage: 'Loading more transactions…' }
      );
      this.infiniteScroll.observe(this.listEl);
    }
  }

  private async loadMore(): Promise<void> {
    if (this.loading || this.allLoaded || this.destroyed) return;
    this.loading = true;
    this.infiniteScroll?.showLoading();

    try {
      const transactions = await this.nwcService.listTransactions({
        limit: PAGE_SIZE,
        offset: this.offset,
      });
      if (this.destroyed) return;

      if (transactions.length < PAGE_SIZE) {
        this.allLoaded = true;
      }
      this.offset += transactions.length;

      this.appendTransactions(transactions);
      this.infiniteScroll?.hideLoading();
      this.infiniteScroll?.refresh();

      if (this.allLoaded) {
        this.infiniteScroll?.pause();
      }
    } catch (err) {
      this.systemLogger.error('WalletTransactionList', 'Failed to load more:', err);
      this.infiniteScroll?.hideLoading();
    } finally {
      this.loading = false;
    }
  }

  private appendTransactions(transactions: NWCTransaction[]): void {
    if (!this.listEl) return;
    const sentinel = this.listEl.querySelector('.infinite-scroll-sentinel');
    for (const tx of transactions) {
      const div = document.createElement('div');
      div.innerHTML = this.renderTransaction(tx);
      const item = div.firstElementChild as HTMLElement;
      if (sentinel) {
        this.listEl.insertBefore(item, sentinel);
      } else {
        this.listEl.appendChild(item);
      }
    }
    void this.fillFiatAmountsForNew(transactions);
  }

  private renderTransaction(tx: NWCTransaction): string {
    const isIncoming = tx.type === 'incoming';
    const sats = Math.floor(tx.amount / 1000);
    const sign = isIncoming ? '+' : '-';
    const cls = isIncoming ? 'wallet-tx--incoming' : 'wallet-tx--outgoing';
    const arrow = isIncoming ? '↙' : '↗';
    const timeStr = this.formatRelativeTime(tx.settled_at || tx.created_at);
    const desc = tx.description ? escapeHtml(tx.description) : (isIncoming ? 'Received' : 'Sent');

    return `
      <div class="ui-list__item ${cls}">
        <div class="wallet-tx__icon">${arrow}</div>
        <div class="wallet-tx__info">
          <span class="wallet-tx__desc">${desc}</span>
          <span class="wallet-tx__time">${escapeHtml(timeStr)}</span>
        </div>
        <div class="wallet-tx__amounts">
          <span class="wallet-tx__sats">${sign}${sats.toLocaleString()} sats</span>
          <span class="wallet-tx__fiat" data-tx-msats="${tx.amount}" data-tx-type="${tx.type}">…</span>
        </div>
      </div>`;
  }

  private async fillFiatBalance(sats: number): Promise<void> {
    if (this.destroyed) return;
    const fiat = await this.exchangeRateService.convertSatsToFiat(sats, this.selectedCurrency);
    if (this.destroyed) return;
    const symbol = this.exchangeRateService.getCurrencySymbol(this.selectedCurrency);
    const formatted = this.exchangeRateService.formatAmount(fiat, this.selectedCurrency);
    const el = this.element.querySelector('.wallet-tx-balance');
    if (el) {
      const fiatSpan = document.createElement('span');
      fiatSpan.className = 'wallet-tx-balance__fiat';
      fiatSpan.textContent = `≈ ${formatted} ${symbol}`;
      el.appendChild(fiatSpan);
    }
  }

  private async fillFiatAmountsForNew(transactions: NWCTransaction[]): Promise<void> {
    if (this.destroyed || transactions.length === 0) return;

    const ratePerSat = await this.exchangeRateService.convertSatsToFiat(1, this.selectedCurrency);
    if (this.destroyed) return;
    const symbol = this.exchangeRateService.getCurrencySymbol(this.selectedCurrency);

    // Only fill elements that still show "…"
    const fiatEls = this.element.querySelectorAll('[data-tx-msats]');
    for (const el of fiatEls) {
      if (el.textContent !== '…') continue;
      const msats = parseInt(el.getAttribute('data-tx-msats') || '0', 10);
      const type = el.getAttribute('data-tx-type');
      const sats = Math.floor(msats / 1000);
      const fiat = sats * ratePerSat;
      const sign = type === 'incoming' ? '' : '-';
      const formatted = this.exchangeRateService.formatAmount(fiat, this.selectedCurrency);
      el.textContent = `${sign}${formatted} ${symbol}`;
    }
  }

  private formatRelativeTime(timestamp: number): string {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;

    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString();
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    this.destroyed = true;
    this.infiniteScroll?.destroy();
    this.infiniteScroll = null;
    window.removeEventListener('nwc-connection-restored', this.onNwcRestored);
    this.element.innerHTML = '';
    this.listEl = null;
  }
}
