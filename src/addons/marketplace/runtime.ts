/**
 * Marketplace addon runtime.
 *
 * The marketplace is already architecturally clean before migration:
 *   - Heavy modules (MarketplaceTimelineInjector, MarketplaceView, listing
 *     views) are only dynamically imported at their call sites — Timeline
 *     loads the injector lazily when it actually starts injecting, and
 *     ViewMountingService loads the views on route navigation.
 *   - `index.ts` contains only cheap flag/frequency accessors (~60 LOC).
 *   - MarketplaceTimelineInjector has its own full-teardown destroy() that
 *     clears the timer, queue, callback, and listingsLoaded flag. Timeline
 *     owns the injector lifecycle via its start/stopMarketplaceInjector
 *     methods, hooked to the marketplace:toggle and
 *     marketplace:timeline-toggle EventBus events.
 *
 * This runtime therefore is a no-op. It exists for uniform AddonLoader
 * lifecycle tracking (diagLog, toggle events via the canonical
 * `marketplace:addon-toggle` event, future extensibility).
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
