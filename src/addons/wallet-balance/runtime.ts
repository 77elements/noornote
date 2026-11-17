/**
 * Wallet Balance addon runtime.
 *
 * Loaded dynamically by AddonLoader only when the addon flag is ON.
 * The static import of WalletBalanceDisplay below is the single entry
 * point that pulls the heavy module into its own chunk — core code no
 * longer imports WalletBalanceDisplay directly.
 *
 * Mount: classic appends the display into `.wallet-balance-container`;
 * the Focus UI has no classic sidebar — there the display mounts detached
 * and the focus stage re-parents it into a side-stack slot via
 * widget.setFocusHost() (structural FocusWidgetLike contract).
 *
 * Destroy contract — must fully unwind:
 *   - WalletBalanceDisplay.destroy() removes the 3 window listeners
 *     (nwc-connection-restored, zap-sent, fiat-currency-changed), clears
 *     the 60s update interval, removes the toggle button click handler,
 *     sets a `destroyed` flag so in-flight async writes are skipped, and
 *     detaches its root element from the DOM.
 *   - `display` is nulled so GC can reclaim the instance and its NWC/
 *     ExchangeRate service references.
 */

import { WalletBalanceDisplay } from '../../components/ui/WalletBalanceDisplay';
import type { AddonContext, AddonRuntime } from '../AddonLoader';

const runtime: AddonRuntime & { widget: WalletBalanceDisplay | null } = {
  widget: null,

  async init(_ctx: AddonContext): Promise<void> {
    if (this.widget) return; // idempotent
    this.widget = new WalletBalanceDisplay();
    // Classic sidebar slot — missing in the Focus UI, where the display
    // mounts detached until the focus stage provides a side-stack host.
    const container = document.querySelector('.wallet-balance-container');
    if (container) container.appendChild(this.widget.getElement());
  },

  async destroy(): Promise<void> {
    if (!this.widget) return;
    this.widget.destroy();
    this.widget = null;
  },
};

export default runtime;
