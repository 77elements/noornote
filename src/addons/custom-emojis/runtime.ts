/**
 * Custom Emojis addon runtime.
 *
 * The heavy modules (EmojiService, CustomEmojiAutocomplete) are already
 * dynamically imported at every call site (PostService, PostNoteModal,
 * PostEditorToolbar, ReplyModal, LikeManager) — they are never part of the
 * static bundle graph. This runtime exists to:
 *   1. Participate in the uniform AddonLoader lifecycle (diagLog, toggle
 *      events, account-switch handling).
 *   2. Own destroy of the EmojiService singleton so account switches don't
 *      leak the previous account's emoji pack through a stale static
 *      instance.
 *
 * Destroy contract:
 *   - EmojiService.destroy() clears the in-memory `emojis` array and
 *     nulls the static singleton. It has no timers and no EventBus
 *     subscriptions, so there is no other cleanup to perform.
 *   - runtime nullifies its own reference so GC can reclaim the service.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import type { EmojiService as Service } from './EmojiService';

export class CustomEmojisRuntime implements AddonRuntime {
  public service: Service | null = null;

  async init(_ctx: AddonContext): Promise<void> {
    if (this.service) return;
    const { EmojiService } = await import('./EmojiService');
    this.service = EmojiService.getInstance();
    // Kick off a relay refresh in the background so the in-memory pack
    // is fresh for the current account. Errors are swallowed inside.
    void this.service.refreshFromRelays();
  }

  async destroy(): Promise<void> {
    if (!this.service) return;
    this.service.destroy();
    this.service = null;
  }
}

export default new CustomEmojisRuntime();
