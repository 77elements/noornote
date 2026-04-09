/**
 * Word Filter addon runtime.
 *
 * Like live-streams-player, this addon is already correctly lazy-loaded:
 *   - Pure filter functions (`filterContentWords`, `getFilterWords`) live in
 *     `index.ts` with no singleton, no state, no timer, no listener.
 *   - Heavy UI modules (ContentWordFilterSettings, WordFilterAddonView) are
 *     already lazy via ViewMountingService.
 *   - Call sites (FeedOrchestrator, RelayBrowserOrchestrator) dynamic-import
 *     the filter function on demand.
 *
 * Consequently the runtime is a no-op. It exists only so the addon
 * participates in the uniform AddonLoader lifecycle (toggle diagLog events,
 * future extensibility).
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
