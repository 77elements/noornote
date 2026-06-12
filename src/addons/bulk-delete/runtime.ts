/**
 * Bulk Delete addon runtime — no-op.
 *
 * The addon is purely a settings-page view (BulkDeleteView): it lists the user's
 * own posts in a time range and deletes selected ones via the posts module +
 * the resumable delete-broadcast (silent mode, on-page progress). There is no
 * long-running background service to own, so init/destroy are no-ops — the addon
 * still participates in AddonLoader for uniform lifecycle + DiagLog tracking.
 */

import type { AddonRuntime } from '../AddonLoader';

const runtime: AddonRuntime = {
  async init(_ctx) { /* no-op — view-only addon, see file header */ },
  async destroy() { /* no-op — see file header */ },
};

export default runtime;
