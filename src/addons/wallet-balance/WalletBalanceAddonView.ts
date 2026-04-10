/**
 * WalletBalanceAddonView
 *
 * View for the Wallet Balance addon page (`/addons/wallet-balance`):
 * shows the enable toggle on top, followed by the live transaction list
 * below — but only while the addon is enabled.
 */

import { View } from '../../components/views/View';
import { Switch } from '../../components/ui/Switch';
import { EventBus } from '../../services/EventBus';
import { ToastService } from '../../services/ToastService';
import { isWalletBalanceEnabled, setWalletBalanceEnabled } from './index';
import type { WalletTransactionList } from './WalletTransactionList';

export class WalletBalanceAddonView extends View {
  private container: HTMLElement;
  private contentEl: HTMLElement | null = null;
  private enableSwitch: Switch | null = null;
  private txList: WalletTransactionList | null = null;
  private toggleSubId: string | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addon view-content--addon-wallet-balance';

    const enabled = isWalletBalanceEnabled();

    this.enableSwitch = new Switch({
      label: '',
      checked: enabled,
      onChange: (checked) => {
        setWalletBalanceEnabled(checked);
        EventBus.getInstance().emit('wallet-balance:addon-toggle', { enabled: checked });
        ToastService.show(
          checked ? 'Wallet Balance enabled' : 'Wallet Balance disabled',
          'success'
        );
        if (checked) this.mountTxList();
        else this.unmountTxList();
      },
    });

    this.container.innerHTML = `
      <h1>Wallet Balance</h1>
      <section class="section">
        <div class="setting">
          <span class="setting__label">Enable Wallet Balance</span>
          <div class="setting__control"></div>
          <p class="setting__desc">Show your Lightning wallet balance in the sidebar with fiat conversion.</p>
        </div>
      </section>
      <div data-addon-content="wallet-balance"></div>
    `;
    this.enableSwitch.setupEventListeners(this.container);
    const controlEl = this.container.querySelector('.setting__control');
    if (controlEl) controlEl.innerHTML = this.enableSwitch.render();
    this.enableSwitch.setupEventListeners(this.container);

    this.contentEl = this.container.querySelector('[data-addon-content="wallet-balance"]');

    if (enabled) {
      this.mountTxList();
    }

    this.toggleSubId = EventBus.getInstance().on('wallet-balance:addon-toggle', (payload: { enabled: boolean }) => {
      if (payload.enabled) this.mountTxList();
      else this.unmountTxList();
    });
  }

  private async mountTxList(): Promise<void> {
    if (!this.contentEl || this.txList) return;
    const { WalletTransactionList } = await import('./WalletTransactionList');
    this.txList = new WalletTransactionList();
    this.contentEl.appendChild(this.txList.getElement());
  }

  private unmountTxList(): void {
    this.txList?.destroy();
    this.txList = null;
    if (this.contentEl) this.contentEl.innerHTML = '';
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.toggleSubId) {
      EventBus.getInstance().off(this.toggleSubId);
      this.toggleSubId = null;
    }
    this.enableSwitch?.destroy();
    this.enableSwitch = null;
    this.unmountTxList();
    this.contentEl = null;
    this.container.innerHTML = '';
  }
}
