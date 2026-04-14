/**
 * Scheduled Posts addon runtime.
 *
 * No-op lifecycle: the addon holds no long-running state. All scheduling
 * work is lazy-loaded at the call sites (PostNoteModal, ArticleEditorView)
 * via dynamic imports of scheduleNote.ts / scheduleArticle.ts. This keeps
 * the core bundle lean when the addon is disabled and makes destroy
 * trivial — there is nothing to unwind here.
 *
 * Destroy contract: trivially satisfied — nothing is held.
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
