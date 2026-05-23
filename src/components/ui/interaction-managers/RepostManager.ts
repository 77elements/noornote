/**
 * RepostManager
 * Handles repost and quote interactions for InteractionStatusLine:
 * - Regular repost
 * - Quoted repost
 * - Button state updates
 */

import { RepostService } from '../../../services/RepostService';
import { RelayConfig } from '../../../services/RelayConfig';
import { ToastService } from '../../../services/ToastService';
import { PostNoteModal } from '../../post/PostNoteModal';
import { getRepostsOriginalEvent } from '../../../helpers/getRepostsOriginalEvent';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { BaseInteractionManager, BaseInteractionConfig } from './BaseInteractionManager';
import { getTag } from '../../../helpers/tagUtils';

export interface RepostManagerConfig extends BaseInteractionConfig {
  originalEvent?: NostrEvent;
  onRepost?: () => void;
  onQuote?: () => void;
}

export class RepostManager extends BaseInteractionManager<RepostManagerConfig> {
  private repostService: RepostService;

  constructor(config: RepostManagerConfig) {
    super(config);
    this.repostService = RepostService.getInstance();
  }

  /**
   * Check if current user has already reposted this note
   */
  public async checkInteractionStatus(): Promise<void> {
    try {
      this.hasInteracted = await this.repostService.hasUserReposted(this.config.noteId);
      if (this.hasInteracted) {
        this.updateButtonState(true);
      }
    } catch (error) {
      console.warn('Failed to check reposted status:', error);
    }
  }

  /**
   * Alias for backwards compatibility
   */
  public async checkRepostedStatus(): Promise<void> {
    return this.checkInteractionStatus();
  }

  /**
   * Handle repost action
   */
  protected handleInteraction(): void {
    this.handleRepost();
  }

  /**
   * Handle repost action
   */
  public async handleRepost(): Promise<void> {
    if (!this.requireAuth('repost this note')) {
      return;
    }

    // Don't allow reposting if already reposted
    if (this.hasInteracted) {
      ToastService.show('You already reposted this note', 'info');
      return;
    }

    // Call custom handler if provided
    if (this.config.onRepost) {
      this.config.onRepost();
      return;
    }

    // Publish repost
    await this.publishRepost();
  }

  /**
   * Handle quote action
   */
  public async handleQuote(): Promise<void> {
    if (!this.requireAuth('quote this note')) {
      return;
    }

    if (this.config.onQuote) {
      this.config.onQuote();
      return;
    }

    await this.openQuotedRepostEditor();
  }

  /**
   * Publish repost to note
   */
  private async publishRepost(): Promise<void> {
    try {
      const originalEvent = this.config.originalEvent;

      if (!originalEvent) {
        ToastService.show('Note not found', 'error');
        return;
      }

      // If reposting a repost (Kind 6), extract the original event
      // Per NIP-18: A repost MUST reference the original event, not another repost
      const unwrappedEvent = await getRepostsOriginalEvent(originalEvent);

      const writeRelays = await RelayConfig.getInstance().getWriteRelays();

      if (writeRelays.length === 0) {
        console.error('No write relays configured');
        return;
      }

      // Kind 1 → standard repost (Kind 6), everything else → generic repost (Kind 16)
      // RepostService resolves own write-relays + author's NIP-65 outbox
      // (Amethyst pattern) internally — no relays passed.
      const isStandardNote = unwrappedEvent.kind === 1;
      const result = isStandardNote
        ? await this.repostService.publishRepost({ originalEvent: unwrappedEvent })
        : await this.repostService.publishGenericRepost({ originalEvent: unwrappedEvent });

      if (result.success) {
        // Update stats (cache invalidation + optimistic UI update)
        this.updateStats('repost');

        // Update reposted state and button appearance
        this.hasInteracted = true;
        this.updateButtonState(true);
      }
    } catch (error) {
      console.error('Failed to publish repost:', error);
    }
  }

  /**
   * Open post editor with pre-filled quoted event reference
   */
  private async openQuotedRepostEditor(): Promise<void> {
    try {
      const originalEvent = this.config.originalEvent;

      if (!originalEvent) {
        ToastService.show('Note not found', 'error');
        return;
      }

      // If this is a repost (Kind 6), extract the original note being reposted
      const unwrappedEvent = await getRepostsOriginalEvent(originalEvent);

      const writeRelays = await RelayConfig.getInstance().getWriteRelays();
      let reference: string;

      // For addressable events (kind 30000-39999: articles, listings, etc.), use naddr encoding
      if (unwrappedEvent.kind && unwrappedEvent.kind >= 30000 && unwrappedEvent.kind < 40000) {
        const { encodeNaddr } = await import('../../../services/NostrToolsAdapter');
        const dTag = getTag(unwrappedEvent.tags, 'd');
        reference = 'nostr:' + encodeNaddr({
          kind: unwrappedEvent.kind,
          pubkey: unwrappedEvent.pubkey,
          identifier: dTag,
          relays: writeRelays.slice(0, 2)
        });
      } else {
        // For regular notes, use nevent encoding
        const eventId = unwrappedEvent.id;
        if (!eventId) {
          ToastService.show('Invalid event', 'error');
          return;
        }
        const { encodeNevent } = await import('../../../helpers/encodeNevent');
        reference = encodeNevent(
          eventId,
          writeRelays,
          unwrappedEvent.pubkey
        );
      }

      // Open post modal with pre-filled content
      PostNoteModal.getInstance().show(reference);
    } catch (error) {
      console.error('Failed to open quoted repost editor:', error);
      ToastService.show('Failed to open editor', 'error');
    }
  }

  /**
   * Update repost button visual state
   */
  protected updateButtonState(reposted: boolean): void {
    if (!this.button) return;

    if (reposted) {
      this.button.classList.add('active');
    } else {
      this.button.classList.remove('active');
    }
  }

  /**
   * Attach event listener to repost button
   */
  public attachRepostListener(repostButton: HTMLElement): void {
    this.setButtonElement(repostButton);

    repostButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleRepost();
    });
  }

  /**
   * Attach event listener to quote button
   */
  public attachQuoteListener(quoteButton: HTMLElement): void {
    quoteButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleQuote();
    });
  }
}
