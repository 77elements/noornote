/**
 * RepostManager
 * Handles repost and quote interactions for InteractionStatusLine:
 * - Regular repost
 * - Quoted repost
 * - Button state updates
 */

import { ModuleLoader } from '../../../core/ModuleLoader';
import type { PostsModuleApi } from '../../../modules/posts/contracts';
import { RelayConfig } from '../../../services/RelayConfig';
import { _ } from '../../../i18n';
import { ToastService } from '../../../services/ToastService';
import { PostNoteModal } from '../../post/PostNoteModal';
import { getRepostsOriginalEvent } from '../../../helpers/getRepostsOriginalEvent';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import {
  BaseInteractionManager,
  BaseInteractionConfig,
} from './BaseInteractionManager';
import { getTag } from '../../../helpers/tagUtils';
import { capRelayHints } from '../../../helpers/capRelayHints';

export interface RepostManagerConfig extends BaseInteractionConfig {
  originalEvent?: NostrEvent;
  onRepost?: () => void;
  onQuote?: () => void;
}

export class RepostManager extends BaseInteractionManager<RepostManagerConfig> {
  private _postsApi?: PostsModuleApi | null;
  private get postsApi(): PostsModuleApi | null {
    return (this._postsApi ??=
      ModuleLoader.getInstance().getApi<PostsModuleApi>('posts'));
  }

  /**
   * In-flight guard: while a publish or removal runs, further repost clicks
   * are ignored. With optimistic UI the icon is green immediately — a second
   * click would otherwise read as toggle-off and start a NIP-09 deletion
   * racing the still-running publish.
   */
  private publishing = false;

  constructor(config: RepostManagerConfig) {
    super(config);
  }

  /**
   * Check if current user has already reposted this note
   */
  public async checkInteractionStatus(): Promise<void> {
    try {
      const reposted = await (this.postsApi?.hasUserReposted(
        this.config.noteId
      ) ?? Promise.resolve(false));
      // A click that landed while this check was in flight wins — never
      // overwrite an optimistic flip with the pre-publish snapshot.
      if (this.publishing) return;
      this.hasInteracted = reposted;
      if (this.hasInteracted) {
        this.updateButtonState(true);
      }
    } catch (error) {
      console.debug('Failed to check reposted status:', error);
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
    void this.handleRepost();
  }

  /**
   * Handle repost action
   */
  public async handleRepost(): Promise<void> {
    if (!this.requireAuth('repost this note')) {
      return;
    }

    // Toggle-off: take the own repost back (NIP-09 deletion of own reposts)
    if (this.hasInteracted) {
      void this.removeRepost();
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
   * Optimistic UI (same pattern as LikeManager.publishReaction): the icon
   * flips green and the count bumps immediately — the stats REQ, outbox
   * discovery and publish below can take several seconds. Reverted when
   * the publish fails.
   */
  private async publishRepost(): Promise<void> {
    // In-flight guard: a second click while publishing is a no-op.
    if (this.publishing) return;
    this.publishing = true;

    try {
      const originalEvent = this.config.originalEvent;

      if (!originalEvent) {
        ToastService.show(_('Note not found'), 'error');
        return;
      }

      // If reposting a repost (Kind 6), extract the original event
      // Per NIP-18: A repost MUST reference the original event, not another repost
      const unwrappedEvent = await getRepostsOriginalEvent(originalEvent);

      const writeRelays = RelayConfig.getInstance().getWriteRelays();

      if (writeRelays.length === 0) {
        console.error('No write relays configured');
        return;
      }

      // Optimistic UI: flip BEFORE any relay work, revert on failure.
      this.hasInteracted = true;
      this.updateButtonState(true);
      this.updateStats('repost');
      this.pulseOnce();

      // Kind 1 → standard repost (Kind 6), everything else → generic repost (Kind 16)
      // RepostService resolves own write-relays + author's NIP-65 outbox
      // (Amethyst pattern) internally — no relays passed.
      const isStandardNote = unwrappedEvent.kind === 1;
      const result = isStandardNote
        ? await (this.postsApi?.publishRepost({
            originalEvent: unwrappedEvent,
          }) ?? Promise.resolve({ success: false }))
        : await (this.postsApi?.publishGenericRepost({
            originalEvent: unwrappedEvent,
          }) ?? Promise.resolve({ success: false }));

      if (!result.success) {
        // alreadyReposted = the service's own-repost bookkeeping found our
        // repost (session map or stats). The correct UI state is ON — set
        // it explicitly (this manager may never have flipped optimistically,
        // e.g. a sibling card's stale mount check). Anything else is a real
        // failure: revert.
        const alreadyReposted =
          'alreadyReposted' in result && result.alreadyReposted === true;
        if (alreadyReposted) {
          this.hasInteracted = true;
          this.updateButtonState(true);
          // Our optimistic count bump above was wrong — the repost already
          // existed. Take it back (state stays ON, count goes back).
          this.updateStats('repost', -1);
        } else {
          this.hasInteracted = false;
          this.updateButtonState(false);
          this.updateStats('repost', -1);
          // Service failure paths already toast (ErrorService / validation).
          // This covers the degraded no-api fallback so every revert has a
          // visible message without double-toasting.
          if (!('error' in result) || !result.error) {
            ToastService.show(_('Repost failed — display reverted'), 'error');
          }
        }
      }
    } catch (error) {
      console.error('Failed to publish repost:', error);
      // Revert optimistic update on error (api failures toast via
      // ErrorService inside the service — no extra toast here).
      this.hasInteracted = false;
      this.updateButtonState(false);
      this.updateStats('repost', -1);
    } finally {
      this.publishing = false;
    }
  }

  /**
   * Take the own repost back: NIP-09 deletion via the posts module.
   * Optimistic revert; restored on failure.
   */
  private async removeRepost(): Promise<void> {
    // In-flight guard: a second click while removing is a no-op.
    if (this.publishing) return;
    this.publishing = true;

    // Optimistic UI: revert immediately before async deletion
    this.hasInteracted = false;
    this.updateButtonState(false);
    this.updateStats('repost', -1);

    try {
      const result = await this.postsApi?.removeRepost(this.config.noteId);

      if (!result?.success) {
        // Revert optimistic update on failure
        this.hasInteracted = true;
        this.updateButtonState(true);
        this.updateStats('repost', 1);
      }
    } catch (error) {
      // Revert optimistic update on error
      this.hasInteracted = true;
      this.updateButtonState(true);
      this.updateStats('repost', 1);
    } finally {
      this.publishing = false;
    }
  }

  /**
   * Open post editor with pre-filled quoted event reference
   */
  private async openQuotedRepostEditor(): Promise<void> {
    try {
      const originalEvent = this.config.originalEvent;

      if (!originalEvent) {
        ToastService.show(_('Note not found'), 'error');
        return;
      }

      // If this is a repost (Kind 6), extract the original note being reposted
      const unwrappedEvent = await getRepostsOriginalEvent(originalEvent);

      const writeRelays = RelayConfig.getInstance().getWriteRelays();
      let reference: string;

      // For addressable events (kind 30000-39999: articles, listings, etc.), use naddr encoding
      if (
        unwrappedEvent.kind &&
        unwrappedEvent.kind >= 30000 &&
        unwrappedEvent.kind < 40000
      ) {
        const { encodeNaddr } = await import(
          '../../../services/NostrToolsAdapter'
        );
        const dTag = getTag(unwrappedEvent.tags, 'd');
        reference = `nostr:${encodeNaddr({
          kind: unwrappedEvent.kind,
          pubkey: unwrappedEvent.pubkey,
          identifier: dTag,
          relays: writeRelays.slice(0, 2),
        })}`;
      } else {
        // For regular notes, use nevent encoding
        const eventId = unwrappedEvent.id;
        if (!eventId) {
          ToastService.show(_('Invalid event'), 'error');
          return;
        }
        const { encodeNevent } = await import('../../../helpers/encodeNevent');
        reference = encodeNevent(
          eventId,
          capRelayHints(writeRelays),
          unwrappedEvent.pubkey
        );
      }

      // Open post modal with pre-filled content
      PostNoteModal.getInstance().show(reference);
    } catch (error) {
      console.error('Failed to open quoted repost editor:', error);
      ToastService.show(_('Failed to open editor'), 'error');
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
   * One-shot "it worked" pulse on the repost icon at the optimistic flip
   * (`.pulse-once` atom, styles/atoms/_pulsate.scss).
   */
  private pulseOnce(): void {
    const btn = this.button;
    if (!btn) return;
    btn.classList.remove('pulse-once');
    // Force a reflow so a repeat click restarts the animation.
    void btn.offsetWidth;
    btn.classList.add('pulse-once');
    btn.addEventListener(
      'animationend',
      () => btn.classList.remove('pulse-once'),
      { once: true }
    );
  }

  /**
   * Attach event listener to repost button
   */
  public attachRepostListener(repostButton: HTMLElement): void {
    this.setButtonElement(repostButton);

    repostButton.addEventListener('click', e => {
      e.stopPropagation();
      void this.handleRepost();
    });
  }

  /**
   * Attach event listener to quote button
   */
  public attachQuoteListener(quoteButton: HTMLElement): void {
    quoteButton.addEventListener('click', e => {
      e.stopPropagation();
      void this.handleQuote();
    });
  }
}
