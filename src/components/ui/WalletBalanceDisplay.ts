/**
 * WalletBalanceDisplay Component
 * Displays Lightning wallet balance in Sats and EUR with toggle visibility
 */

import { NWCService } from '../../services/NWCService';
import { SystemLogger } from '../system/SystemLogger';
import { ExchangeRateService } from '../../services/ExchangeRateService';
import { KeychainStorage } from '../../services/KeychainStorage';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
import satsIconUrl from '../../assets/sats.svg';

export class WalletBalanceDisplay {
  private element: HTMLElement;
  private nwcService: NWCService;
  private systemLogger: SystemLogger;
  private exchangeRateService: ExchangeRateService;
  private balanceInMsats: number = 0;
  private balanceVisible: boolean = false; // Default: hidden
  private selectedCurrency: string = 'EUR';
  private updateInterval: number | null = null;

  constructor() {
    this.nwcService = NWCService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.exchangeRateService = ExchangeRateService.getInstance();

    // Load visibility preference
    this.balanceVisible = PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.WALLET_BALANCE_VISIBLE, false);

    // Load currency preference
    this.loadCurrencyPreference();

    this.element = this.createElement();
    this.setupEventListeners();
    this.updateEyeIcon(); // Set initial icon state
    this.loadBalance();
    this.startAutoUpdate();
  }

  private async loadCurrencyPreference(): Promise<void> {
    try {
      const currency = await KeychainStorage.loadFiatCurrency();
      if (currency) {
        this.selectedCurrency = currency;
      }
    } catch (error) {
      this.systemLogger.error('WalletBalanceDisplay', 'Failed to load currency preference:', error);
    }
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'wallet-balance-display';
    container.innerHTML = `
      <div class="wallet-balance-content">
        <span class="wallet-balance-amount">--</span>
        <img src="${satsIconUrl}" class="sats-icon" alt="sats" />
        <span class="wallet-balance-exchange">⇄</span>
        <span class="wallet-balance-fiat-amount">--</span>
      </div>
      <button class="wallet-balance-toggle" title="Toggle visibility" aria-label="Toggle balance visibility">
        <svg class="eye-icon eye-open"><use href="#icon-eye-open"/></svg>
        <svg class="eye-icon eye-closed" style="display: none;"><use href="#icon-eye-closed"/></svg>
      </button>
    `;
    return container;
  }

  private setupEventListeners(): void {
    const toggleBtn = this.element.querySelector('.wallet-balance-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => this.toggleVisibility());
    }

    // Listen for NWC connection events
    window.addEventListener('nwc-connection-restored', () => {
      this.loadBalance();
    });

    // Listen for payment events (refresh balance after zap)
    window.addEventListener('zap-sent', () => {
      setTimeout(() => this.loadBalance(), 2000); // Wait 2s for payment to settle
    });

    // Listen for currency change events
    window.addEventListener('fiat-currency-changed', async (event: Event) => {
      const customEvent = event as CustomEvent;
      const currency = customEvent.detail?.currency;
      if (currency) {
        this.selectedCurrency = currency;
        this.updateDisplay(this.balanceInMsats);
      }
    });
  }

  private async loadBalance(): Promise<void> {
    if (!this.nwcService.isConnected()) {
      this.updateDisplay(null);
      return;
    }

    try {
      const balanceMsats = await this.nwcService.getBalance();
      if (balanceMsats !== null) {
        this.balanceInMsats = balanceMsats;
        this.updateDisplay(balanceMsats);
      } else {
        this.updateDisplay(null);
      }
    } catch (error) {
      this.systemLogger.error('WalletBalanceDisplay', 'Failed to load balance:', error);
      this.updateDisplay(null);
    }
  }

  private async updateDisplay(balanceMsats: number | null): Promise<void> {
    const amountEl = this.element.querySelector('.wallet-balance-amount');
    const fiatAmountEl = this.element.querySelector('.wallet-balance-fiat-amount');

    if (balanceMsats === null || !this.nwcService.isConnected()) {
      // Not connected - hide display
      this.element.style.display = 'none';
      return;
    }

    // Show display
    this.element.style.display = 'block';

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
    const fiatAmount = await this.exchangeRateService.convertSatsToFiat(sats, this.selectedCurrency);
    const currencySymbol = this.exchangeRateService.getCurrencySymbol(this.selectedCurrency);

    let formattedFiat: string;
    if (fiatAmount < 0.01) {
      const minAmount = this.exchangeRateService.formatAmount(0.01, this.selectedCurrency);
      formattedFiat = `<${minAmount} ${currencySymbol}`;
    } else {
      const formattedAmount = this.exchangeRateService.formatAmount(fiatAmount, this.selectedCurrency);
      formattedFiat = `${formattedAmount} ${currencySymbol}`;
    }

    if (fiatAmountEl) fiatAmountEl.textContent = formattedFiat;
  }

  private formatSats(sats: number, currency: string): string {
    if (sats >= 1000000) {
      const value = sats / 1000000;
      const formatted = this.exchangeRateService.formatAmount(value, currency, 1);
      return `${formatted}M`;
    } else if (sats >= 1000) {
      const value = sats / 1000;
      const formatted = this.exchangeRateService.formatAmount(value, currency, 1);
      return `${formatted}k`;
    }
    return sats.toLocaleString();
  }

  private toggleVisibility(): void {
    this.balanceVisible = !this.balanceVisible;

    PerAccountLocalStorage.getInstance().set(StorageKeys.WALLET_BALANCE_VISIBLE, this.balanceVisible);

    this.updateEyeIcon();
    this.updateDisplay(this.balanceInMsats);
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
        this.loadBalance();
      }
    }, 60000);
  }

  public destroy(): void {
    if (this.updateInterval !== null) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.element.remove();
  }

  public getElement(): HTMLElement {
    return this.element;
  }
}
