/**
 * WalletBalanceDisplay Component
 * Displays Lightning wallet balance in Sats and EUR with toggle visibility
 */

import { NWCService } from '../../services/NWCService';
import { SystemLogger } from '../../services/SystemLogger';
import { ExchangeRateService } from '../../services/ExchangeRateService';
import { KeychainStorage } from '../../services/KeychainStorage';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';

export class WalletBalanceDisplay {
  private element: HTMLElement;
  private nwcService: NWCService;
  private systemLogger: SystemLogger;
  private exchangeRateService: ExchangeRateService;
  private balanceInMsats: number = 0;
  private hasBalance: boolean = false; // True once we've ever received a successful balance
  private balanceVisible: boolean = false; // Default: hidden
  private selectedCurrency: string = 'EUR';
  private updateInterval: number | null = null;
  private destroyed = false;

  // Named handler refs so destroy() can remove them. Anonymous arrow functions
  // in addEventListener cannot be removed afterwards — this was the root cause
  // of the listener leak that made the balance display flicker after long
  // runtime and after account switches.
  private toggleBtnHandler: (() => void) | null = null;
  private toggleBtnEl: Element | null = null;
  private onNwcRestored: () => void = () => this.loadBalance();
  private onZapSent: () => void = () => {
    window.setTimeout(() => {
      if (!this.destroyed) void this.loadBalance();
    }, 2000);
  };
  private onFiatCurrencyChanged: (e: Event) => void = (event: Event) => {
    const customEvent = event as CustomEvent;
    const currency = customEvent.detail?.currency;
    if (currency) {
      this.selectedCurrency = currency;
      void this.updateDisplay(this.balanceInMsats);
    }
  };

  constructor() {
    this.nwcService = NWCService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.exchangeRateService = ExchangeRateService.getInstance();

    // Load visibility preference
    this.balanceVisible = PerAccountLocalStorage.getInstance().get<boolean>(
      StorageKeys.WALLET_BALANCE_VISIBLE,
      false
    );

    // Load last known balance (shown while waiting for fresh fetch; kept on fetch failures)
    const cachedMsats = PerAccountLocalStorage.getInstance().get<number>(
      StorageKeys.WALLET_BALANCE_LAST_MSATS,
      0
    );
    if (cachedMsats > 0) {
      this.balanceInMsats = cachedMsats;
      this.hasBalance = true;
    }

    // Load currency preference
    void this.loadCurrencyPreference();

    this.element = this.createElement();
    this.setupEventListeners();
    this.updateEyeIcon(); // Set initial icon state
    if (this.hasBalance) {
      void this.updateDisplay(this.balanceInMsats);
    }
    void this.loadBalance();
    this.startAutoUpdate();
  }

  private async loadCurrencyPreference(): Promise<void> {
    try {
      const currency = await KeychainStorage.loadFiatCurrency();
      if (currency) {
        this.selectedCurrency = currency;
      }
    } catch (error) {
      this.systemLogger.error(
        'WalletBalanceDisplay',
        'Failed to load currency preference:',
        error
      );
    }
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'wallet-balance-display';
    container.innerHTML = `
      <div class="wallet-balance-content">
        <span class="wallet-balance-amount">--</span>
        <span class="sats-icon">丰</span>
        <svg class="wallet-balance-exchange"><use href="#icon-switch-arrows-horizontal"/></svg>
        <span class="wallet-balance-fiat-amount">--</span>
        <button class="wallet-balance-toggle" title="Toggle visibility" aria-label="Toggle balance visibility">
          <svg class="eye-icon eye-open"><use href="#icon-eye-open"/></svg>
          <svg class="eye-icon eye-closed" style="display: none;"><use href="#icon-eye-closed"/></svg>
        </button>
      </div>
    `;
    return container;
  }

  private setupEventListeners(): void {
    this.toggleBtnEl = this.element.querySelector('.wallet-balance-toggle');
    if (this.toggleBtnEl) {
      this.toggleBtnHandler = () => this.toggleVisibility();
      this.toggleBtnEl.addEventListener('click', this.toggleBtnHandler);
    }

    // Listen for NWC connection events
    window.addEventListener('nwc-connection-restored', this.onNwcRestored);

    // Listen for payment events (refresh balance after zap)
    window.addEventListener('zap-sent', this.onZapSent);

    // Listen for currency change events
    window.addEventListener(
      'fiat-currency-changed',
      this.onFiatCurrencyChanged
    );
  }

  private async loadBalance(): Promise<void> {
    if (!this.nwcService.isConnected()) {
      // NWC not connected: only show placeholder if we have no cached value to fall back on
      if (!this.hasBalance) void this.updateDisplay(null);
      return;
    }

    try {
      const balanceMsats = await this.nwcService.getBalance();
      if (balanceMsats !== null) {
        this.balanceInMsats = balanceMsats;
        this.hasBalance = true;
        PerAccountLocalStorage.getInstance().set(
          StorageKeys.WALLET_BALANCE_LAST_MSATS,
          balanceMsats
        );
        void this.updateDisplay(balanceMsats);
      } else if (!this.hasBalance) {
        // No cached value yet — show placeholder
        void this.updateDisplay(null);
      }
      // On null with cached value: keep showing last known balance (don't reset)
    } catch (error) {
      this.systemLogger.error(
        'WalletBalanceDisplay',
        'Failed to load balance:',
        error
      );
      if (!this.hasBalance) void this.updateDisplay(null);
      // Keep showing last known balance on errors (rate limiting, network, etc.)
    }
  }

  private async updateDisplay(balanceMsats: number | null): Promise<void> {
    const amountEl = this.element.querySelector('.wallet-balance-amount');
    const fiatAmountEl = this.element.querySelector(
      '.wallet-balance-fiat-amount'
    );

    // Always visible when addon is ON — show placeholder until NWC connects.
    this.element.style.display = 'block';

    if (balanceMsats === null) {
      // No value available — show placeholder, will refresh on nwc-connection-restored
      if (amountEl) amountEl.textContent = '--';
      if (fiatAmountEl) fiatAmountEl.textContent = '--';
      return;
    }

    if (!this.balanceVisible) {
      // Hidden state
      if (amountEl) amountEl.textContent = '••••';
      if (fiatAmountEl) fiatAmountEl.textContent = '••••';
      return;
    }

    // Convert msats to sats
    const sats = Math.floor(balanceMsats / 1000);

    // Format sats with k/M suffix (locale-aware)
    const formattedSats = this.formatSats(sats, this.selectedCurrency);
    if (amountEl) amountEl.textContent = formattedSats;

    // Convert to selected fiat currency
    const fiatAmount = await this.exchangeRateService.convertSatsToFiat(
      sats,
      this.selectedCurrency
    );
    const currencySymbol = this.exchangeRateService.getCurrencySymbol(
      this.selectedCurrency
    );

    let formattedFiat: string;
    if (fiatAmount < 0.01) {
      const minAmount = this.exchangeRateService.formatAmount(
        0.01,
        this.selectedCurrency
      );
      formattedFiat = `<${minAmount} ${currencySymbol}`;
    } else {
      const formattedAmount = this.exchangeRateService.formatAmount(
        fiatAmount,
        this.selectedCurrency
      );
      formattedFiat = `${formattedAmount} ${currencySymbol}`;
    }

    if (fiatAmountEl) fiatAmountEl.textContent = formattedFiat;
  }

  private formatSats(sats: number, currency: string): string {
    if (sats >= 1000000) {
      const value = sats / 1000000;
      const formatted = this.exchangeRateService.formatAmount(
        value,
        currency,
        1
      );
      return `${formatted}M`;
    } else if (sats >= 1000) {
      const value = sats / 1000;
      const formatted = this.exchangeRateService.formatAmount(
        value,
        currency,
        1
      );
      return `${formatted}k`;
    }
    return sats.toLocaleString();
  }

  private toggleVisibility(): void {
    this.balanceVisible = !this.balanceVisible;

    PerAccountLocalStorage.getInstance().set(
      StorageKeys.WALLET_BALANCE_VISIBLE,
      this.balanceVisible
    );

    this.updateEyeIcon();
    void this.updateDisplay(this.balanceInMsats);
  }

  private updateEyeIcon(): void {
    const eyeOpen = this.element.querySelector('.eye-open') as HTMLElement;
    const eyeClosed = this.element.querySelector('.eye-closed') as HTMLElement;

    if (this.balanceVisible) {
      if (eyeOpen) eyeOpen.style.display = 'block';
      if (eyeClosed) eyeClosed.style.display = 'none';
    } else {
      if (eyeOpen) eyeOpen.style.display = 'none';
      if (eyeClosed) eyeClosed.style.display = 'block';
    }
  }

  private startAutoUpdate(): void {
    // Update balance every 60 seconds
    this.updateInterval = window.setInterval(() => {
      if (this.nwcService.isConnected()) {
        void this.loadBalance();
      }
    }, 60000);
  }

  public destroy(): void {
    // Cancel flag prevents in-flight async (loadBalance, onZapSent setTimeout)
    // from writing state or DOM after teardown.
    this.destroyed = true;

    if (this.updateInterval !== null) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    // Remove window listeners (root cause of post-long-runtime flicker).
    window.removeEventListener('nwc-connection-restored', this.onNwcRestored);
    window.removeEventListener('zap-sent', this.onZapSent);
    window.removeEventListener(
      'fiat-currency-changed',
      this.onFiatCurrencyChanged
    );

    if (this.toggleBtnEl && this.toggleBtnHandler) {
      this.toggleBtnEl.removeEventListener('click', this.toggleBtnHandler);
    }
    this.toggleBtnEl = null;
    this.toggleBtnHandler = null;

    this.element.remove();
  }

  public getElement(): HTMLElement {
    return this.element;
  }
}
