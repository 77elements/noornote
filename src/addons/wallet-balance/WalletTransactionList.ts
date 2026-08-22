/**
 * WalletTransactionList — Displays NWC transaction history with balance summary.
 *
 * Mounted into `data-addon-content="wallet-balance"` by WalletBalanceAddonView
 * when the addon toggle is ON. Uses `.ui-list` / `.ui-list__item` for rows.
 * Loads 20 transactions initially, more via InfiniteScroll (offset pagination).
 */

import { NWCService, type NWCTransaction } from '../../services/NWCService';
import { ExchangeRateService } from '../../services/ExchangeRateService';
import { UserProfileService } from '../../services/UserProfileService';
import { KeychainStorage } from '../../services/KeychainStorage';
import { SystemLogger } from '../../services/SystemLogger';
import { InfiniteScroll } from '../../components/ui/InfiniteScroll';
import { escapeHtml } from '../../helpers/escapeHtml';
import { formatTimeAgo } from '../../helpers/formatTimeAgo';

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
    this.element.innerHTML =
      '<p class="wallet-tx-list__placeholder pulsate">Loading transactions…</p>';

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
    } catch {
      /* keep default */
    }
  }

  private async loadInitial(): Promise<void> {
    if (this.destroyed) return;

    if (!this.nwcService.isConnected()) {
      this.element.innerHTML =
        '<p class="wallet-tx-list__placeholder">Wallet not connected</p>';
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
        this.element.innerHTML =
          '<p class="wallet-tx-list__placeholder">Failed to load transactions</p>';
      }
    }
  }

  private renderInitial(
    balanceMsats: number | null,
    transactions: NWCTransaction[]
  ): void {
    const balanceSats =
      balanceMsats !== null ? Math.floor(balanceMsats / 1000) : null;

    // Balance summary
    let html = `<div class="wallet-tx-balance">`;
    if (balanceSats !== null) {
      html += `<span class="wallet-tx-balance__sats">${balanceSats.toLocaleString()}</span>`;
      html += ` <span class="wallet-tx-balance__sats-icon">丰</span>`;
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
        () => {
          void this.loadMore();
        },
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
      this.systemLogger.error(
        'WalletTransactionList',
        'Failed to load more:',
        err
      );
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
    void this.resolveZapProfiles();
  }

  private renderTransaction(tx: NWCTransaction): string {
    const isIncoming = tx.type === 'incoming';
    const sats = Math.floor(tx.amount / 1000);
    const sign = isIncoming ? '+' : '-';
    const cls = isIncoming ? 'wallet-tx--incoming' : 'wallet-tx--outgoing';
    const timeStr = formatTimeAgo((tx.settled_at || tx.created_at) * 1000);

    // Extract zap sender info from metadata.nostr (kind 9734 zap request)
    const zapRequest = (tx as any).metadata?.nostr;
    const isAnon =
      zapRequest?.tags?.some((t: string[]) => t[0] === 'anon') ?? false;
    const senderPubkey =
      !isAnon && isIncoming && zapRequest?.pubkey
        ? (zapRequest.pubkey as string)
        : null;
    const zapMessage = zapRequest?.content
      ? escapeHtml(zapRequest.content as string)
      : null;

    // Icon: profile pic placeholder for zaps, arrow for regular
    let iconHtml: string;
    if (senderPubkey) {
      iconHtml = `<img class="wallet-tx__avatar profile-pic profile-pic--mini" data-zap-pubkey="${senderPubkey}" src="" alt="" />`;
    } else {
      const arrow = isIncoming ? '↙' : '↗';
      iconHtml = `<div class="wallet-tx__icon">${arrow}</div>`;
    }

    // Description: sender name (placeholder) + zap message, or generic
    let desc: string;
    if (senderPubkey) {
      const name = `<span class="wallet-tx__sender" data-zap-pubkey-name="${senderPubkey}">…</span>`;
      desc = zapMessage
        ? `${name}<br><span class="wallet-tx__zap-msg">"${zapMessage}"</span>`
        : name;
    } else {
      desc = tx.description
        ? escapeHtml(tx.description)
        : isIncoming
          ? 'Received'
          : 'Sent';
    }

    return `
      <div class="ui-list__item ${cls}">
        ${iconHtml}
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

  /** Fetch profiles for zap senders and fill in avatars + names */
  private async resolveZapProfiles(): Promise<void> {
    if (this.destroyed) return;
    const profileService = UserProfileService.getInstance();

    // Collect unique pubkeys from data attributes
    const avatarEls = this.element.querySelectorAll<HTMLImageElement>(
      'img[data-zap-pubkey]'
    );
    const pubkeys = new Set<string>();
    for (const el of avatarEls) {
      pubkeys.add(el.getAttribute('data-zap-pubkey')!);
    }
    if (pubkeys.size === 0) return;

    for (const pubkey of pubkeys) {
      if (this.destroyed) return;
      try {
        const profile = await profileService.getUserProfile(pubkey);
        if (this.destroyed) return;

        // Fill avatars
        const imgs = this.element.querySelectorAll<HTMLImageElement>(
          `[data-zap-pubkey="${pubkey}"]`
        );
        for (const img of imgs) {
          if (profile.picture) {
            img.src = profile.picture;
          } else {
            // Replace img with arrow icon if no picture
            const div = document.createElement('div');
            div.className = 'wallet-tx__icon';
            div.textContent = '↙';
            img.replaceWith(div);
          }
        }

        // Fill names
        const nameEls = this.element.querySelectorAll(
          `[data-zap-pubkey-name="${pubkey}"]`
        );
        const displayName =
          profile.display_name || profile.name || `${pubkey.substring(0, 8)}…`;
        for (const el of nameEls) {
          el.textContent = displayName;
        }
      } catch {
        /* profile fetch failed, keep placeholder */
      }
    }
  }

  private async fillFiatBalance(sats: number): Promise<void> {
    if (this.destroyed) return;
    const fiat = await this.exchangeRateService.convertSatsToFiat(
      sats,
      this.selectedCurrency
    );
    if (this.destroyed) return;
    const symbol = this.exchangeRateService.getCurrencySymbol(
      this.selectedCurrency
    );
    const formatted = this.exchangeRateService.formatAmount(
      fiat,
      this.selectedCurrency
    );
    const el = this.element.querySelector('.wallet-tx-balance');
    if (el) {
      const fiatSpan = document.createElement('span');
      fiatSpan.className = 'wallet-tx-balance__fiat';
      fiatSpan.textContent = `≈ ${formatted} ${symbol}`;
      el.appendChild(fiatSpan);
    }
  }

  private async fillFiatAmountsForNew(
    transactions: NWCTransaction[]
  ): Promise<void> {
    if (this.destroyed || transactions.length === 0) return;

    const ratePerSat = await this.exchangeRateService.convertSatsToFiat(
      1,
      this.selectedCurrency
    );
    if (this.destroyed) return;
    const symbol = this.exchangeRateService.getCurrencySymbol(
      this.selectedCurrency
    );

    // Only fill elements that still show "…"
    const fiatEls = this.element.querySelectorAll('[data-tx-msats]');
    for (const el of fiatEls) {
      if (el.textContent !== '…') continue;
      const msats = parseInt(el.getAttribute('data-tx-msats') || '0', 10);
      const type = el.getAttribute('data-tx-type');
      const sats = Math.floor(msats / 1000);
      const fiat = sats * ratePerSat;
      const sign = type === 'incoming' ? '' : '-';
      const formatted = this.exchangeRateService.formatAmount(
        fiat,
        this.selectedCurrency
      );
      el.textContent = `${sign}${formatted} ${symbol}`;
    }
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
