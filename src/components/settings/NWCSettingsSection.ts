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
import { PlatformService } from '../../services/PlatformService';
import { AuthService } from '../../services/AuthService';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
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
  private storageSwitch?: Switch;
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
      await KeychainStorage.saveZapDefaults(this.zapDefaults.amount, this.zapDefaults.comment);
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
      await KeychainStorage.saveFiatCurrency(this.fiatCurrencySettings.currency);

      window.dispatchEvent(new CustomEvent('fiat-currency-changed', {
        detail: { currency: this.fiatCurrencySettings.currency }
      }));
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
   * Render currency options for dropdown
   */
  private renderCurrencyOptions(): string {
    const currencies = this.exchangeRateService.getAvailableCurrencies();

    return currencies
      .map(currency => `<option value="${currency.code}" ${this.fiatCurrencySettings.currency === currency.code ? 'selected' : ''}>${currency.symbol} ${currency.name} (${currency.code})</option>`)
      .join('');
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
        <div class="zap-connected">
          <div class="zap-wallet-status">
            <span class="wallet-icon">⚡</span>
            <div class="wallet-connected-info">
              <span class="wallet-connected-text">Lightning Wallet Connected</span>
              ${lightningAddress ? `<span class="wallet-ln-address">${lightningAddress}</span>` : ''}
            </div>
            <button class="btn btn--mini" id="nwc-disconnect-btn">Disconnect</button>
          </div>
        </div>
      `
      : `
        <div class="zap-info">
          <p>Connect your Lightning wallet via Nostr Wallet Connect (NWC) to send zaps. Get your NWC connection string from your Lightning wallet provider (Alby, Mutiny, etc.).</p>
        </div>

        <div class="zap-connect">
          <label for="nwc-connection-string">NWC Connection String:</label>
          <input
            type="password"
            id="nwc-connection-string"
            class="nwc-input"
            placeholder="nostr+walletconnect://..."
          />
          <button class="btn btn--medium" id="nwc-connect-btn">Connect Wallet</button>
        </div>
      `;

    // Zap defaults section (always visible)
    const zapDefaultsSection = `
        <h3 class="subsection-title">Zap Settings</h3>

        <div id="quick-zap-switch-container"></div>

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

        <div class="form__row form__row--oneline">
          <label for="fiat-currency-select">Zap Balance Fiat Currency:</label>
          <select id="fiat-currency-select">
            ${this.renderCurrencyOptions()}
          </select>
        </div>
    `;

    return `
        <section class="section">
          ${nwcSection}
        </section>

        <section class="section">
          ${zapDefaultsSection}
        </section>

        <section class="section">
          <div id="nwc-storage-switch-container"></div>
          <p class="form__info" id="nwc-storage-info"></p>
        </section>
    `;
  }

  /**
   * Setup Quick Zap toggle switch
   */
  private setupQuickZapSwitch(contentContainer: HTMLElement): void {
    const container = contentContainer.querySelector('#quick-zap-switch-container');
    if (!container) return;

    const storage = PerAccountLocalStorage.getInstance();
    const quickZapEnabled = storage.get(StorageKeys.QUICK_ZAP_ENABLED, false);

    this.quickZapSwitch = new Switch({
      label: 'Quick Zap',
      checked: quickZapEnabled,
      onChange: (checked) => {
        storage.set(StorageKeys.QUICK_ZAP_ENABLED, checked);
        ToastService.show(checked ? 'Quick zap enabled' : 'Quick zap disabled', 'success');
      }
    });

    container.innerHTML = this.quickZapSwitch.render()
      + '<p class="form__info">Single click sends zap with default amount. When disabled, click opens zap dialog.</p>';
    this.quickZapSwitch.setupEventListeners(container as HTMLElement);
  }

  /**
   * Setup NWC storage switch (Keychain vs Encrypted File)
   */
  private async setupStorageSwitch(contentContainer: HTMLElement): Promise<void> {
    // Only show on desktop (not browser or mobile)
    const _p = PlatformService.getInstance();
    if (!_p.isDesktop) {
      return;
    }

    const container = contentContainer.querySelector('#nwc-storage-switch-container');
    if (!container) return;

    const storage = PerAccountLocalStorage.getInstance();
    const useEncryptedFile = storage.get(StorageKeys.NWC_USE_ENCRYPTED_FILE, false);

    this.storageSwitch = new Switch({
      label: 'Store in encrypted file (instead of Keychain)',
      checked: useEncryptedFile,
      onChange: async (checked) => {
        storage.set(StorageKeys.NWC_USE_ENCRYPTED_FILE, checked);
        await this.updateStorageInfo(contentContainer, checked);

        // If switching WITH existing NWC connection: migrate
        if (this.nwcService.isConnected()) {
          await this.migrateNWCStorage(checked);
        }
      }
    });

    container.innerHTML = this.storageSwitch.render();
    this.storageSwitch.setupEventListeners(container as HTMLElement);

    await this.updateStorageInfo(contentContainer, useEncryptedFile);
  }

  /**
   * Update storage info text (shows file path or iCloud warning)
   */
  private async updateStorageInfo(contentContainer: HTMLElement, useEncryptedFile: boolean): Promise<void> {
    const infoEl = contentContainer.querySelector('#nwc-storage-info');
    if (!infoEl) return;

    if (useEncryptedFile) {
      // Show file path
      const { EncryptedFileStorage } = await import('../../services/EncryptedFileStorage');
      const auth = AuthService.getInstance();
      const user = auth.getCurrentUser();
      if (user) {
        const path = await EncryptedFileStorage.getDisplayPath(user.pubkey);
        infoEl.innerHTML = `📁 Stored at: <code>${path}</code>`;
      }
    } else {
      // Check iCloud (macOS only)
      if (PlatformService.getInstance().isMac) {
        infoEl.innerHTML = `Stored securely in macOS Keychain.<br><span class="icloud-warning">Not recommended if you're syncing your keychain to iCloud!</span>`;
      } else {
        infoEl.textContent = 'Stored securely in system keychain';
      }
    }
  }

  /**
   * Migrate NWC between storage methods
   */
  private async migrateNWCStorage(toEncryptedFile: boolean): Promise<void> {
    const auth = AuthService.getInstance();
    const user = auth.getCurrentUser();
    if (!user) return;

    try {
      if (toEncryptedFile) {
        // Keychain → File
        const nwc = await KeychainStorage.loadNWC(user.pubkey);
        if (nwc) {
          const { EncryptedFileStorage } = await import('../../services/EncryptedFileStorage');
          await EncryptedFileStorage.saveNWC(nwc, user.pubkey);
          await KeychainStorage.deleteNWC(user.pubkey);
          ToastService.show('NWC migrated to encrypted file', 'success');
        }
      } else {
        // File → Keychain
        const { EncryptedFileStorage } = await import('../../services/EncryptedFileStorage');
        const nwc = await EncryptedFileStorage.loadNWC(user.pubkey);
        if (nwc) {
          await KeychainStorage.saveNWC(nwc, user.pubkey);
          await EncryptedFileStorage.deleteNWC(user.pubkey);
          ToastService.show('NWC migrated to Keychain', 'success');
        }
      }
    } catch (error) {
      ToastService.show('Failed to migrate NWC storage', 'error');
      console.error('[NWCSettings] Migration error:', error);
    }
  }

  /**
   * Bind event listeners
   */
  private async bindListeners(contentContainer: HTMLElement): Promise<void> {
    const isConnected = this.nwcService.isConnected();

    // Setup switches
    this.setupQuickZapSwitch(contentContainer);
    await this.setupStorageSwitch(contentContainer);

    if (!isConnected) {
      // Connect button
      const connectBtn = contentContainer.querySelector('#nwc-connect-btn');
      const connectionInput = contentContainer.querySelector('#nwc-connection-string') as HTMLInputElement;

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
          const parentContainer = contentContainer.closest('.settings-container') as HTMLElement;
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
      const disconnectBtn = contentContainer.querySelector('#nwc-disconnect-btn');
      disconnectBtn?.addEventListener('click', async () => {
        await this.nwcService.disconnect();
        // Refresh zap settings panel to show disconnected state
        const parentContainer = contentContainer.closest('.settings-container') as HTMLElement;
        if (parentContainer) {
          this.mount(parentContainer);
        }
      });
    }

    // Zap default amount: save on blur / Enter
    const amountInput = contentContainer.querySelector('#zap-default-amount') as HTMLInputElement;
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
    amountInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveAmount(); });

    // Zap default comment: save on blur / Enter
    const commentInput = contentContainer.querySelector('#zap-default-comment') as HTMLInputElement;
    const saveComment = async () => {
      this.zapDefaults.comment = commentInput?.value || '';
      await this.saveZapDefaults();
      ToastService.show('Zap defaults saved', 'success');
    };
    commentInput?.addEventListener('blur', saveComment);
    commentInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveComment(); });

    // Fiat currency: save on change
    const currencySelect = contentContainer.querySelector('#fiat-currency-select') as HTMLSelectElement;
    currencySelect?.addEventListener('change', async () => {
      this.fiatCurrencySettings.currency = currencySelect.value;
      await this.saveFiatCurrencySettings();
      ToastService.show('Fiat currency saved', 'success');
    });
  }

  /**
   * Unmount section and cleanup
   */
  public unmount(): void {
    // Cleanup if needed
  }
}
