/**
 * Analytics addon runtime.
 *
 * This addon is fully VIEW-DRIVEN: AnalyticsAddonView (lazy-loaded by
 * ViewMountingService when /addons/analytics is visited) dynamically imports
 * the collectors / service / store and starts runs only while the user is
 * actually looking at the page — never at login. Relay sweeps are strictly
 * visit-triggered (relay-friendliness by design, see
 * docs/todos/analytics-addon.md).
 *
 * The per-account AnalyticsStore DB is opened via NoorDB's registry
 * (perAccount: true), so account switches and logouts close it centrally —
 * nothing for this runtime to unwind.
 *
 * Consequently the runtime here is intentionally a no-op. It exists only so
 * the addon participates in the uniform AddonLoader lifecycle (register /
 * toggle events / diagLog in the 'addons' area / future extensibility).
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
