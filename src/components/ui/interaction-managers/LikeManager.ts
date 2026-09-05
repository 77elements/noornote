/**
 * LikeManager
 * Handles like interactions for InteractionStatusLine:
 * - Emoji picker for reactions
 * - Reaction publishing
 * - Button state updates
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { RelayConfig } from '../../../services/RelayConfig';
import { ToastService } from '../../../services/ToastService';
import { EmojiPicker, type CustomEmojiEntry } from '../../emoji/EmojiPicker';
import { isCustomEmojisEnabled } from '../../../addons/custom-emojis/index';
import {
  BaseInteractionManager,
  BaseInteractionConfig,
} from './BaseInteractionManager';

export interface LikeManagerConfig extends BaseInteractionConfig {
  onLike?: () => void;
  /** Original reacted-to event — required for NIP-25-compliant reactions on
   *  addressable events (kind 30000–39999, e.g. long-form articles). When
   *  set, ReactionService builds the correct `e`/`a`/`k` tag combination.
   *  Without it, articles get the addressable identifier in the `e`-tag and
   *  strict relays reject the reaction. */
  originalEvent?: NostrEvent;
}

export class LikeManager extends BaseInteractionManager<LikeManagerConfig> {
  private emojiPicker: EmojiPicker | null = null;

  constructor(config: LikeManagerConfig) {
    super(config);
  }

  /**
   * Check if current user has already liked this note
   */
  public async checkInteractionStatus(): Promise<void> {
    try {
      this.hasInteracted =
        (await this.reactionsApi?.hasUserLiked(this.config.noteId)) ?? false;
      if (this.hasInteracted) {
        this.updateButtonState(true);
      }
    } catch (error) {
      console.debug('Failed to check liked status:', error);
    }
  }

  /**
   * Alias for backwards compatibility
   */
  public async checkLikedStatus(): Promise<void> {
    return this.checkInteractionStatus();
  }

  /**
   * Handle like action - Show emoji picker
   */
  protected handleInteraction(): void {
    void this.handleLike();
  }

  /**
   * Handle like action - Show emoji picker, or take the like back on second click
   */
  public async handleLike(): Promise<void> {
    if (!this.requireAuth('like this note')) {
      return;
    }

    // Toggle-off: take the own like back (NIP-09 deletion of own reactions)
    if (this.hasInteracted) {
      void this.removeLike();
      return;
    }

    // Call custom handler if provided
    if (this.config.onLike) {
      this.config.onLike();
      return;
    }

    if (!this.button) {
      return;
    }

    // Close existing picker if open
    if (this.emojiPicker) {
      this.emojiPicker.destroy();
      this.emojiPicker = null;
      return;
    }

    // Custom emojis (NIP-30) — only loaded when the addon is enabled
    let customEmojis: CustomEmojiEntry[] | undefined;
    if (isCustomEmojisEnabled()) {
      try {
        const { EmojiService } = await import(
          '../../../addons/custom-emojis/EmojiService'
        );
        const service = EmojiService.getInstance();
        void service.refreshFromRelays();
        customEmojis = service.getEmojis();
      } catch (err) {
        console.debug('[LikeManager] Custom emoji load failed:', err);
      }
    }

    // Create and show emoji picker
    this.emojiPicker = new EmojiPicker({
      triggerElement: this.button,
      ...(customEmojis ? { customEmojis } : {}),
      onSelect: emoji => {
        void this.publishReaction(emoji);
        this.emojiPicker?.hide();
        this.emojiPicker?.destroy();
        this.emojiPicker = null;
      },
      onCustomSelect: entry => {
        void this.publishReaction(`:${entry.shortcode}:`, [
          'emoji',
          entry.shortcode,
          entry.url,
        ]);
        this.emojiPicker?.hide();
        this.emojiPicker?.destroy();
        this.emojiPicker = null;
      },
    });

    this.emojiPicker.show();
  }

  /**
   * Publish reaction to note with selected emoji
   * @param emoji   Reaction content (regular emoji char or `:shortcode:` for NIP-30)
   * @param emojiTag Optional NIP-30 emoji tag for custom emoji reactions
   */
  private async publishReaction(
    emoji: string,
    emojiTag?: [string, string, string]
  ): Promise<void> {
    // Optimistic UI: update immediately before async publish
    this.hasInteracted = true;
    this.updateButtonState(true);
    this.updateStats('like');

    try {
      const writeRelays = RelayConfig.getInstance().getWriteRelays();

      if (writeRelays.length === 0) {
        // Revert optimistic update
        this.hasInteracted = false;
        this.updateButtonState(false);
        ToastService.show('No write relays configured', 'error');
        return;
      }

      const result = await this.reactionsApi?.publishReaction({
        noteId: this.config.noteId,
        authorPubkey: this.config.authorPubkey,
        emoji,
        ...(emojiTag ? { emojiTag } : {}),
        ...(this.config.originalEvent
          ? { targetEvent: this.config.originalEvent }
          : {}),
      });

      if (!result?.success) {
        // Revert optimistic update on failure
        this.hasInteracted = false;
        this.updateButtonState(false);
      }
    } catch (error) {
      // Revert optimistic update on error
      this.hasInteracted = false;
      this.updateButtonState(false);
    }
  }

  /**
   * Take the own like back: NIP-09 deletion via the reactions module.
   * Optimistic revert; restored on failure.
   */
  private async removeLike(): Promise<void> {
    // Optimistic UI: revert immediately before async deletion
    this.hasInteracted = false;
    this.updateButtonState(false);
    this.updateStats('like', -1);

    try {
      const result = await this.reactionsApi?.removeReaction(
        this.config.noteId
      );

      if (!result?.success) {
        // Revert optimistic update on failure
        this.hasInteracted = true;
        this.updateButtonState(true);
        this.updateStats('like', 1);
      }
    } catch (error) {
      // Revert optimistic update on error
      this.hasInteracted = true;
      this.updateButtonState(true);
      this.updateStats('like', 1);
    }
  }

  /**
   * Update like button visual state
   */
  protected updateButtonState(liked: boolean): void {
    if (!this.button) return;

    const likeBtn = this.button as HTMLButtonElement;
    // Stay clickable in both states — second click takes the like back.
    likeBtn.disabled = false;
    if (liked) {
      likeBtn.classList.add('active');
    } else {
      likeBtn.classList.remove('active');
    }
  }

  /**
   * Destroy manager and cleanup resources
   */
  public override destroy(): void {
    if (this.emojiPicker) {
      this.emojiPicker.destroy();
      this.emojiPicker = null;
    }
    super.destroy();
  }
}
