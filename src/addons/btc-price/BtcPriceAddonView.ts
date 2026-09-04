/**
 * BtcPriceAddonView
 *
 * View for the BTC Price addon page (`/addons/btc-price`): enable toggle on
 * top, then — while the addon is enabled — the live "1 BTC = …" rate display
 * plus the "Show BTC Sidebar Widget" switch and the shared Fiat Currency
 * dropdown in the addon content zone.
 */

import { View } from '../../components/views/View';
import { Switch } from '../../components/ui/Switch';
import { CustomDropdown } from '../../components/ui/CustomDropdown';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';
import { ExchangeRateService } from '../../services/ExchangeRateService';
import { KeychainStorage } from '../../services/KeychainStorage';
import { AddonLoader } from '../AddonLoader';
import {
  isBtcPriceEnabled,
  setBtcPriceEnabled,
  isBtcPriceSidebarWidget,
  setBtcPriceSidebarWidget,
} from './index';
import type { BtcPriceSidebarWidget } from './BtcPriceSidebarWidget';
import type { BtcPriceRuntime } from './runtime';

export class BtcPriceAddonView extends View {
  private container: HTMLElement;
  private contentEl: HTMLElement | null = null;
  private enableSwitch: Switch | null = null;
  private widgetSwitch: Switch | null = null;
  private currencyDropdown: CustomDropdown | null = null;
  private display: BtcPriceSidebarWidget | null = null;
  private toggleSubId: string | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-btc-price';

    const enabled = isBtcPriceEnabled();

    this.enableSwitch = new Switch({
      label: '',
      checked: enabled,
      onChange: checked => {
        setBtcPriceEnabled(checked);
        TypedEventBus.getInstance().emit('btc-price:addon-toggle', {
          enabled: checked,
        });
        ToastService.show(
          checked ? 'BTC Price enabled' : 'BTC Price disabled',
          'success'
        );
        if (checked) void this.mountContent();
        else this.unmountContent();
      },
    });

    this.container.innerHTML = `
      <h1>BTC Price</h1>
      <section class="section">
        <div class="setting">
          <span class="setting__label">Enable BTC Price</span>
          <div class="setting__control"></div>
          <p class="setting__desc">Show the current Bitcoin exchange rate on this page and — via the switch below — as a widget in the sidebar.</p>
        </div>
      </section>
      <div data-addon-content="btc-price"></div>
    `;
    const controlEl = this.container.querySelector('.setting__control');
    if (controlEl) controlEl.innerHTML = this.enableSwitch.render();
    this.enableSwitch.setupEventListeners(this.container);

    this.contentEl = this.container.querySelector(
      '[data-addon-content="btc-price"]'
    );

    if (enabled) {
      void this.mountContent();
    }

    this.toggleSubId = TypedEventBus.getInstance().on(
      'btc-price:addon-toggle',
      (payload: { enabled: boolean }) => {
        if (payload.enabled) void this.mountContent();
        else this.unmountContent();
      }
    );
  }

  private async mountContent(): Promise<void> {
    if (!this.contentEl || this.display) return;

    this.contentEl.innerHTML = `
      <div class="btc-price-display"></div>
      <section class="section">
        <div class="setting">
          <span class="setting__label">Show BTC Sidebar Widget</span>
          <div class="setting__control" data-btc-sidebar-switch-mount></div>
          <p class="setting__desc">Show the "1 BTC = …" rate line in the sidebar, above the prayer-times widget.</p>
        </div>
        <div class="setting">
          <span class="setting__label">Fiat Currency</span>
          <div class="setting__control" data-btc-currency-mount></div>
          <p class="setting__desc">Shared with Zaps and the Wallet Balance addon — changing it updates everywhere.</p>
        </div>
      </section>
    `;

    const { BtcPriceSidebarWidget } = await import('./BtcPriceSidebarWidget');
    if (!this.contentEl || this.display) return; // unmounted while loading

    this.display = new BtcPriceSidebarWidget({
      container: () =>
        this.contentEl?.querySelector('.btc-price-display') ?? null,
      visible: () => isBtcPriceEnabled() && !!this.contentEl,
    });
    this.display.mount();

    this.setupWidgetSwitch();
    await this.setupCurrencyDropdown();
  }

  private setupWidgetSwitch(): void {
    const mount = this.contentEl?.querySelector(
      '[data-btc-sidebar-switch-mount]'
    );
    if (!mount) return;

    this.widgetSwitch = new Switch({
      label: '',
      checked: isBtcPriceSidebarWidget(),
      onChange: checked => {
        setBtcPriceSidebarWidget(checked);
        AddonLoader.getInstance()
          .getRuntime<BtcPriceRuntime>('btc-price')
          ?.widget?.refresh();
      },
    });
    mount.innerHTML = this.widgetSwitch.render();
    this.widgetSwitch.setupEventListeners(this.contentEl as HTMLElement);
  }

  private async setupCurrencyDropdown(): Promise<void> {
    const mount = this.contentEl?.querySelector('[data-btc-currency-mount]');
    if (!mount) return;

    const stored = await KeychainStorage.loadFiatCurrency();
    if (!this.contentEl) return; // unmounted while loading

    const currencies =
      ExchangeRateService.getInstance().getAvailableCurrencies();
    const options = currencies.map(c => ({
      value: c.code,
      label: `${c.symbol} ${c.name} (${c.code})`,
    }));

    this.currencyDropdown = new CustomDropdown({
      options,
      selectedValue: stored ?? 'EUR',
      onChange: async code => {
        await KeychainStorage.saveFiatCurrency(code);
        window.dispatchEvent(
          new CustomEvent('fiat-currency-changed', {
            detail: { currency: code },
          })
        );
        ToastService.show('Fiat currency saved', 'success');
      },
    });
    mount.appendChild(this.currencyDropdown.getElement());
  }

  private unmountContent(): void {
    this.currencyDropdown?.destroy();
    this.currencyDropdown = null;
    this.widgetSwitch?.destroy();
    this.widgetSwitch = null;
    this.display?.destroy();
    this.display = null;
    if (this.contentEl) this.contentEl.innerHTML = '';
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.toggleSubId) {
      TypedEventBus.getInstance().off(this.toggleSubId);
      this.toggleSubId = null;
    }
    this.enableSwitch?.destroy();
    this.enableSwitch = null;
    this.unmountContent();
    this.contentEl = null;
    this.container.innerHTML = '';
  }
}
