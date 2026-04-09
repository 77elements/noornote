/**
 * Wallet Balance addon runtime.
 *
 * Loaded dynamically by AddonLoader only when the addon flag is ON.
 * The static import of WalletBalanceDisplay below is the single entry
 * point that pulls the heavy module into its own chunk — core code no
 * longer imports WalletBalanceDisplay directly.
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

let display: WalletBalanceDisplay | null = null;

const runtime: AddonRuntime = {
  async init(_ctx: AddonContext): Promise<void> {
    if (display) return; // idempotent
    const container = document.querySelector('.wallet-balance-container');
    if (!container) {
      // Mount point not in DOM (e.g. sidebar not rendered yet). AddonLoader
      // will retry on the next user:login / toggle. We diagLog at the loader
      // level; here we just silently no-op.
      return;
    }
    display = new WalletBalanceDisplay();
    container.appendChild(display.getElement());
  },

  async destroy(): Promise<void> {
    if (!display) return;
    display.destroy();
    display = null;
  },
};

export default runtime;
