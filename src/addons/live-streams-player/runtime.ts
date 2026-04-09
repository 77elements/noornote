/**
 * Live Streams Player addon runtime.
 *
 * This addon is already architecturally correct BEFORE the AddonLoader
 * migration: `player.ts` + `hls.js` are only dynamically imported on
 * demand by ArticlePreviewRenderer when a live-stream card is rendered
 * AND the addon flag is on. There is no persistent state, no singleton,
 * no global listener, no timer. Each `mountPlayer()` call returns a
 * self-contained PlayerHandle whose destroy() fully tears down the video
 * element and its hls.js instance.
 *
 * Consequently the runtime here is intentionally a no-op. It exists only
 * so the addon participates in the uniform AddonLoader lifecycle
 * (register / toggle events / diagLog in the 'addons' area / future
 * extensibility). Heavy code is NOT loaded by this runtime — it's loaded
 * by ArticlePreviewRenderer.upgradeToInlinePlayer() when actually needed.
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
