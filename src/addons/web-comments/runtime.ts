/**
 * Web Comments addon runtime.
 *
 * This addon is render-only: a NIP-22 comment (kind:1111) whose root scope is a
 * web URL (NIP-73 `K`/`k` = "web") gets a small "Commenting on <site>" card
 * appended to its note body. That card is built purely from the event's tags
 * and is loaded on demand by OriginalNoteRenderer — and only when the flag is on
 * AND the event actually carries a web scope. There is no persistent state, no
 * singleton, no global listener, no timer.
 *
 * Consequently the runtime here is intentionally a no-op. It exists only so the
 * addon participates in the uniform AddonLoader lifecycle (register / toggle
 * events / diagLog in the 'addons' area / future extensibility). Heavy code is
 * NOT loaded by this runtime — it's loaded by OriginalNoteRenderer when a web
 * comment is actually rendered.
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
