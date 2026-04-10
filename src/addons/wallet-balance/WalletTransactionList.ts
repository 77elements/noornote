/**
 * WalletTransactionList — Displays NWC transaction history with balance summary.
 *
 * Mounted into `data-addon-content="wallet-balance"` by WalletBalanceAddonView
 * when the addon toggle is ON. Uses `.ui-list` / `.ui-list__item` for rows.
 */

import { NWCService } from '../../services/NWCService';
import type { NWCTransaction } from '../../services/NWCService';
import { ExchangeRateService } from '../../services/ExchangeRateService';
import { KeychainStorage } from '../../services/KeychainStorage';
import { SystemLogger } from '../../components/system/SystemLogger';
import { escapeHtml } from '../../helpers/escapeHtml';
import satsIconUrl from '../../assets/sats.svg';

export class WalletTransactionList {
  private element: HTMLElement;
  private nwcService: NWCService;
  private exchangeRateService: ExchangeRateService;
  private systemLogger: SystemLogger;
  private selectedCurrency = 'EUR';
  private destroyed = false;
  private onNwcRestored: () => void;

  constructor() {
    this.nwcService = NWCService.getInstance();
    this.exchangeRateService = ExchangeRateService.getInstance();
    this.systemLogger = SystemLogger.getInstance();

    this.element = document.createElement('div');
    this.element.className = 'wallet-tx-list';
    this.element.innerHTML = '<p class="wallet-tx-list__placeholder pulsate">Loading transactions…</p>';

    this.onNwcRestored = () => { void this.load(); };
    window.addEventListener('nwc-connection-restored', this.onNwcRestored);

    void this.init();
  }

  private async init(): Promise<void> {
    await this.loadCurrency();
    await this.load();
  }

  private async loadCurrency(): Promise<void> {
    try {
      const c = await KeychainStorage.loadFiatCurrency();
      if (c) this.selectedCurrency = c;
    } catch { /* keep default */ }
  }

  private async load(): Promise<void> {
    if (this.destroyed) return;

    if (!this.nwcService.isConnected()) {
      this.element.innerHTML = '<p class="wallet-tx-list__placeholder">Wallet not connected</p>';
      return;
    }

    try {
      const [balanceMsats, transactions] = await Promise.all([
        this.nwcService.getBalance(),
        this.nwcService.listTransactions({ limit: 50 }),
      ]);
      if (this.destroyed) return;
      this.render(balanceMsats, transactions);
    } catch (err) {
      this.systemLogger.error('WalletTransactionList', 'Failed to load:', err);
      if (!this.destroyed) {
        this.element.innerHTML = '<p class="wallet-tx-list__placeholder">Failed to load transactions</p>';
      }
    }
  }

  private render(balanceMsats: number | null, transactions: NWCTransaction[]): void {
    const balanceSats = balanceMsats !== null ? Math.floor(balanceMsats / 1000) : null;

    let html = '';

    // Balance summary
    html += `<div class="wallet-tx-balance">`;
    if (balanceSats !== null) {
      html += `<span class="wallet-tx-balance__sats">${balanceSats.toLocaleString()}</span>`;
      html += ` <img src="${satsIconUrl}" class="wallet-tx-balance__sats-icon" alt="sats" />`;
    } else {
      html += `<span class="wallet-tx-balance__sats">--</span>`;
    }
    html += `</div>`;

    // Transactions
    if (transactions.length === 0) {
      html += '<p class="wallet-tx-list__placeholder">No transactions yet</p>';
    } else {
      html += '<div class="ui-list">';
      for (const tx of transactions) {
        html += this.renderTransaction(tx);
      }
      html += '</div>';
    }

    this.element.innerHTML = html;

    // Async: fill in fiat amounts
    if (balanceSats !== null) {
      void this.fillFiatBalance(balanceSats);
    }
    void this.fillFiatAmounts(transactions);
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

  private async fillFiatAmounts(transactions: NWCTransaction[]): Promise<void> {
    if (this.destroyed || transactions.length === 0) return;

    const ratePerSat = await this.exchangeRateService.convertSatsToFiat(1, this.selectedCurrency);
    if (this.destroyed) return;
    const symbol = this.exchangeRateService.getCurrencySymbol(this.selectedCurrency);

    const fiatEls = this.element.querySelectorAll('[data-tx-msats]');
    for (const el of fiatEls) {
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
    window.removeEventListener('nwc-connection-restored', this.onNwcRestored);
    this.element.innerHTML = '';
  }
}
