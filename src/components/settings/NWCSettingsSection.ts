/**
 * NWCSettingsSection Component
 * Manages Nostr Wallet Connect (NWC), Zap defaults, and Quick Zap settings
 *
 * @purpose Configure Lightning wallet connection, zap defaults, and Quick Zap toggle
 * @used-by SettingsView
 */

import { SettingsSection } from './SettingsSection';
import { NWCService } from '../../services/NWCService';
import { ExchangeRateService } from '../../services/ExchangeRateService';
import { Switch } from '../ui/Switch';
import { CustomDropdown } from '../ui/CustomDropdown';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';
import { KeychainStorage } from '../../services/KeychainStorage';
import { ToastService } from '../../services/ToastService';

interface ZapDefaults {
  amount: number;
  comment: string;
}

interface FiatCurrencySettings {
  currency: string;
}

export class NWCSettingsSection extends SettingsSection {
  private nwcService: NWCService;
  private exchangeRateService: ExchangeRateService;
  private zapDefaults: ZapDefaults;
  private fiatCurrencySettings: FiatCurrencySettings;

  private quickZapSwitch?: Switch;

  constructor() {
    super('zaps');
    this.nwcService = NWCService.getInstance();
    this.exchangeRateService = ExchangeRateService.getInstance();
    this.zapDefaults = { amount: 21, comment: '' };
    this.fiatCurrencySettings = { currency: 'EUR' };
  }

  /**
   * Load zap defaults from storage
   */
  private async loadZapDefaults(): Promise<ZapDefaults> {
    try {
      const stored = await KeychainStorage.loadZapDefaults();
      if (stored) {
        return stored;
      }
    } catch (error) {
      console.warn('Failed to load zap defaults:', error);
    }

    return { amount: 21, comment: '' };
  }

  /**
   * Save zap defaults to Keychain/localStorage
   */
  private async saveZapDefaults(): Promise<void> {
    try {
      await KeychainStorage.saveZapDefaults(
        this.zapDefaults.amount,
        this.zapDefaults.comment
      );
    } catch (error) {
      console.warn('Failed to save zap defaults:', error);
    }
  }

  /**
   * Load fiat currency settings from storage
   */
  private async loadFiatCurrencySettings(): Promise<FiatCurrencySettings> {
    try {
      const stored = await KeychainStorage.loadFiatCurrency();
      if (stored) {
        return { currency: stored };
      }
    } catch (error) {
      console.warn('Failed to load fiat currency settings:', error);
    }

    return { currency: 'EUR' };
  }

  /**
   * Save fiat currency settings to storage
   */
  private async saveFiatCurrencySettings(): Promise<void> {
    try {
      await KeychainStorage.saveFiatCurrency(
        this.fiatCurrencySettings.currency
      );

      window.dispatchEvent(
        new CustomEvent('fiat-currency-changed', {
          detail: { currency: this.fiatCurrencySettings.currency },
        })
      );
    } catch (error) {
      console.warn('Failed to save fiat currency settings:', error);
    }
  }

  /**
   * Mount section content into the DOM
   */
  public async mount(parentContainer: HTMLElement): Promise<void> {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    // Load defaults BEFORE rendering
    this.zapDefaults = await this.loadZapDefaults();
    this.fiatCurrencySettings = await this.loadFiatCurrencySettings();

    contentContainer.innerHTML = this.renderContent();
    this.bindListeners(contentContainer);

    // Listen for NWC connection restoration event
    window.addEventListener('nwc-connection-restored', () => {
      this.mount(parentContainer); // Re-render to show connected state
    });
  }

  /**
   * Render zap settings content
   */
  private renderContent(): string {
    const isConnected = this.nwcService.isConnected();
    const lightningAddress = this.nwcService.getLightningAddress();

    // NWC connection section (connect or disconnect)
    const nwcSection = isConnected
      ? `
        <div class="zap-wallet-status">
            <span class="wallet-icon">⚡</span>
            <div class="wallet-connected-info">
              <span class="wallet-connected-text">Lightning Wallet Connected</span>
              ${lightningAddress ? `<span class="wallet-ln-address">${lightningAddress}</span>` : ''}
            </div>
            <button class="btn" id="nwc-disconnect-btn">Disconnect</button>
        </div>
      `
      : `
        <div class="setting">
          <span class="setting__label">NWC String</span>
          <div class="setting__control setting__control--stretch">
            <input
              type="password"
              id="nwc-string"
              class="input"
              placeholder="nostr+walletconnect://..."
            />
          </div>
          <p class="setting__desc">Connect your Lightning wallet via Nostr Wallet Connect (NWC) to send zaps.</p>
        </div>
        <div class="l-row l-row--center">
          <button class="btn" id="nwc-connect-btn">Connect Wallet</button>
        </div>
      `;

    // Zap defaults section (always visible)
    const zapDefaultsSection = `
        <h2 class="subsection-title">Zap Settings</h3>

        <div class="setting" id="quick-zap-switch-container">
          <span class="setting__label">Quick Zap</span>
          <div class="setting__control" id="quick-zap-switch-mount"></div>
          <p class="setting__desc">Single click sends zap with default amount. When disabled, click opens zap dialog.</p>
        </div>

        <div class="form__row form__row--oneline">
          <label for="zap-default-amount">Default Amount (sats):</label>
          <input
            type="number"
            id="zap-default-amount"
            min="1"
            value="${this.zapDefaults.amount}"
          />
        </div>

        <div class="form__row form__row--oneline">
          <label for="zap-default-comment">Default Comment (optional):</label>
          <input
            type="text"
            id="zap-default-comment"
            placeholder="Great post!"
            value="${this.zapDefaults.comment}"
            maxlength="200"
          />
        </div>

        <div class="setting">
          <span class="setting__label">Zap Balance Fiat Currency</span>
          <div class="setting__control" id="fiat-currency-dropdown-mount"></div>
        </div>
    `;

    return `
        <section class="section">
          ${nwcSection}
        </section>

        <section class="section">
          ${zapDefaultsSection}
        </section>

    `;
  }

  /**
   * Setup Quick Zap toggle switch
   */
  private setupQuickZapSwitch(contentContainer: HTMLElement): void {
    const mount = contentContainer.querySelector('#quick-zap-switch-mount');
    if (!mount) return;

    const storage = PerAccountLocalStorage.getInstance();
    const quickZapEnabled = storage.get(StorageKeys.QUICK_ZAP_ENABLED, false);

    this.quickZapSwitch = new Switch({
      label: '',
      checked: quickZapEnabled,
      onChange: checked => {
        storage.set(StorageKeys.QUICK_ZAP_ENABLED, checked);
        ToastService.show(
          checked ? 'Quick zap enabled' : 'Quick zap disabled',
          'success'
        );
      },
    });

    mount.innerHTML = this.quickZapSwitch.render();
    this.quickZapSwitch.setupEventListeners(mount as HTMLElement);
  }

  /**
   * Setup fiat currency dropdown
   */
  private setupFiatCurrencyDropdown(contentContainer: HTMLElement): void {
    const mount = contentContainer.querySelector(
      '#fiat-currency-dropdown-mount'
    );
    if (!mount) return;

    const currencies = this.exchangeRateService.getAvailableCurrencies();
    const options = currencies.map(c => ({
      value: c.code,
      label: `${c.symbol} ${c.name} (${c.code})`,
    }));

    const dropdown = new CustomDropdown({
      options,
      selectedValue: this.fiatCurrencySettings.currency,
      onChange: async value => {
        this.fiatCurrencySettings.currency = value;
        await this.saveFiatCurrencySettings();
        ToastService.show('Fiat currency saved', 'success');
      },
    });

    mount.appendChild(dropdown.getElement());
  }

  /**
   * Bind event listeners
   */
  private async bindListeners(contentContainer: HTMLElement): Promise<void> {
    const isConnected = this.nwcService.isConnected();

    // Setup switches
    this.setupQuickZapSwitch(contentContainer);

    // Setup fiat currency dropdown
    this.setupFiatCurrencyDropdown(contentContainer);

    if (!isConnected) {
      // Connect button
      const connectBtn = contentContainer.querySelector('#nwc-connect-btn');
      const connectionInput = contentContainer.querySelector(
        '#nwc-string'
      ) as HTMLInputElement;

      connectBtn?.addEventListener('click', async () => {
        const connectionString = connectionInput?.value.trim();
        if (!connectionString) {
          ToastService.show('Please enter NWC connection string', 'error');
          return;
        }

        // Show loading state
        (connectBtn as HTMLButtonElement).disabled = true;
        (connectBtn as HTMLButtonElement).textContent = 'Connecting...';

        // Attempt connection
        const success = await this.nwcService.connect(connectionString);

        if (success) {
          // Refresh zap settings panel to show connected state
          const parentContainer = contentContainer.closest(
            '.view-content--settings'
          ) as HTMLElement;
          if (parentContainer) {
            this.mount(parentContainer);
          }
        } else {
          // Re-enable button on failure
          (connectBtn as HTMLButtonElement).disabled = false;
          (connectBtn as HTMLButtonElement).textContent = 'Connect Wallet';
        }
      });
    } else {
      // Disconnect button
      const disconnectBtn = contentContainer.querySelector(
        '#nwc-disconnect-btn'
      );
      disconnectBtn?.addEventListener('click', async () => {
        await this.nwcService.disconnect();
        // Refresh zap settings panel to show disconnected state
        const parentContainer = contentContainer.closest(
          '.view-content--settings'
        ) as HTMLElement;
        if (parentContainer) {
          this.mount(parentContainer);
        }
      });
    }

    // Zap default amount: save on blur / Enter
    const amountInput = contentContainer.querySelector(
      '#zap-default-amount'
    ) as HTMLInputElement;
    const saveAmount = async () => {
      const amount = parseInt(amountInput?.value || '21', 10);
      if (amount < 1) {
        ToastService.show('Amount must be at least 1 sat', 'error');
        return;
      }
      this.zapDefaults.amount = amount;
      await this.saveZapDefaults();
      ToastService.show('Zap defaults saved', 'success');
    };
    amountInput?.addEventListener('blur', saveAmount);
    amountInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') saveAmount();
    });

    // Zap default comment: save on blur / Enter
    const commentInput = contentContainer.querySelector(
      '#zap-default-comment'
    ) as HTMLInputElement;
    const saveComment = async () => {
      this.zapDefaults.comment = commentInput?.value || '';
      await this.saveZapDefaults();
      ToastService.show('Zap defaults saved', 'success');
    };
    commentInput?.addEventListener('blur', saveComment);
    commentInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') saveComment();
    });
  }

  /**
   * Unmount section and cleanup
   */
  public unmount(): void {
    // Cleanup if needed
  }
}
