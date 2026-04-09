/**
 * Follow Packs addon runtime.
 *
 * Follow Packs is already architecturally clean: no singleton, no timer,
 * no EventBus subscription, no global listener. FollowPackManager is a
 * plain class instantiated on demand by FollowPacksView, and the view
 * itself is lazy-loaded via ViewMountingService on route navigation.
 *
 * This runtime is a no-op. It exists for uniform AddonLoader lifecycle
 * tracking (diagLog, toggle events via the canonical
 * `follow-packs:addon-toggle` event, future extensibility).
 *
 * Destroy contract: trivially satisfied — nothing is held here.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';

const runtime: AddonRuntime = {
  async init(_ctx: AddonContext): Promise<void> {
    /* no-op — see file header */
  },
  async destroy(): Promise<void> {
    /* no-op — see file header */
  },
};

export default runtime;
