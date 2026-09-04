/**
 * btc-price addon runtime (AddonLoader lifecycle).
 *
 * Owns the sidebar rate widget; torn down by destroy() so timers, DOM nodes
 * and the fiat-currency listener never leak across logout / account-switch /
 * toggle-off. The addon page display is owned by BtcPriceAddonView instead.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import { diagLog } from '../../services/DiagnosticLogger';
import { BtcPriceSidebarWidget } from './BtcPriceSidebarWidget';
import { isBtcPriceSidebarWidget } from './index';

export class BtcPriceRuntime implements AddonRuntime {
  private initialized = false;
  /** Public so the settings view can refresh it live via AddonLoader.getRuntime(). */
  public widget: BtcPriceSidebarWidget | null = null;

  async init(ctx: AddonContext): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.widget = new BtcPriceSidebarWidget({
      container: () =>
        document.querySelector('[data-sidebar-widget="btc-price"]'),
      visible: isBtcPriceSidebarWidget,
    });
    this.widget.mount();
    diagLog('addons', 'btc-price: runtime init', {
      npub: ctx.npub?.slice(0, 12),
    });
  }

  async destroy(): Promise<void> {
    if (!this.initialized) return;
    this.initialized = false;
    this.widget?.destroy();
    this.widget = null;
    diagLog('addons', 'btc-price: runtime destroy');
  }
}

export default new BtcPriceRuntime();
