/**
 * ZapReceiptRenderer - Renders kind:9735 zap receipts
 * Displays zap information in a visually distinct card
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { UserProfileService } from '../../../services/UserProfileService';
import { getViewNavigationController } from '../../../services/ViewNavigationController';
import {
  renderUserMention,
  setupUserMentionHandlers,
} from '../../../helpers/UserMentionHelper';
import { buildZapReactionEntries } from '../../../helpers/zapUtils';
import { escapeHtml } from '../../../helpers/escapeHtml';

export class ZapReceiptRenderer {
  private static profileService = UserProfileService.getInstance();

  /**
   * Render zap receipt element
   */
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const zapData = note.zapReceiptData;
    if (!zapData) {
      return ZapReceiptRenderer.createFallbackElement(note);
    }

    const element = document.createElement('div');
    element.className = 'note-card note-card--zap-receipt';
    if (note.id) element.dataset.eventId = note.id;
    // Needed by updateReactions() (called from SnvZapsListController with the
    // card element only) to build the "→ <zap sender>" part of the line.
    if (zapData.senderPubkey)
      element.dataset.senderPubkey = zapData.senderPubkey;

    // Format amount with thousand separators
    const formattedAmount = zapData.amountSats.toLocaleString();

    // Get sender and recipient mentions
    const senderMention = zapData.senderPubkey
      ? ZapReceiptRenderer.mentionHtml(zapData.senderPubkey)
      : '<span class="zap-receipt__anonymous">Anonymous</span>';
    const recipientMention = ZapReceiptRenderer.mentionHtml(
      zapData.recipientPubkey
    );

    // Build HTML
    element.innerHTML = `
      <div class="zap-receipt">
        <div class="zap-receipt__header">
          <span class="zap-receipt__icon">⚡</span>
          <span class="zap-receipt__amount">${formattedAmount} sats</span>
        </div>
        <div class="zap-receipt__details">
          ${senderMention}
          <span class="zap-receipt__arrow">→</span>
          ${recipientMention}
        </div>
        ${zapData.message ? `<div class="zap-receipt__message">"${escapeHtml(zapData.message)}"</div>` : ''}
      </div>
    `;

    // Click on the receipt card opens the zapped note's SingleNoteView — the
    // receipt is a wallet-signed technical event, the zapped note is the
    // interesting target. Media/mention/button clicks keep their own behavior
    // (click-propagation guard, /build-validate Step 15b). Inert previews
    // (ReplyModal parent context) opt out via zapReceiptClickable: false.
    if (zapData.targetEventId && opts.zapReceiptClickable !== false) {
      element.classList.add('note-card--zap-receipt--clickable');
      element.addEventListener('click', e => {
        const target = e.target as HTMLElement;
        if (
          target.tagName === 'A' ||
          target.tagName === 'BUTTON' ||
          target.tagName === 'IMG' ||
          target.tagName === 'VIDEO' ||
          target.closest('a') ||
          target.closest('button') ||
          target.closest('.nn-dropdown')
        ) {
          return;
        }
        getViewNavigationController().openView(
          'single-note',
          zapData.targetEventId!,
          e
        );
      });
    }

    // Setup click handlers and hover cards
    setupUserMentionHandlers(element);

    return element;
  }

  /**
   * Replace the sender→recipient details line with the reaction line
   * ("❤️ Cody 👍 Bob → Alp") when reactions exist on this receipt. Called by
   * SnvZapsListController.renderNow (which holds the reaction stats for the
   * receipt id). Idempotent via the reaction-signature dataset guard; without
   * reactions the sender→recipient fallback stays untouched.
   */
  static updateReactions(
    card: HTMLElement,
    reactionEvents: NostrEvent[]
  ): void {
    const details = card.querySelector('.zap-receipt__details');
    if (!details || reactionEvents.length === 0) return;
    const signature = reactionEvents.map(e => e.id ?? '').join(',');
    if (card.dataset.reactionSignature === signature) return;
    const entries = buildZapReactionEntries(reactionEvents);
    if (entries.length === 0) return;
    card.dataset.reactionSignature = signature;

    const reactionsHtml = entries
      .map(
        e =>
          `<span class="zap-receipt__reaction">${e.emojiHtml}</span>${ZapReceiptRenderer.mentionHtml(e.pubkey)}`
      )
      .join('');
    const senderPubkey = card.dataset.senderPubkey;
    const senderHtml = senderPubkey
      ? ZapReceiptRenderer.mentionHtml(senderPubkey)
      : '<span class="zap-receipt__anonymous">Anonymous</span>';
    details.innerHTML = `${reactionsHtml}<span class="zap-receipt__arrow">→</span>${senderHtml}`;

    // The new mention links need hover cards + click navigation.
    setupUserMentionHandlers(card);
  }

  /**
   * Cached-profile mention link (sender/recipient/reactors).
   */
  private static mentionHtml(pubkey: string): string {
    const profile = ZapReceiptRenderer.profileService.getCachedProfile(pubkey);
    const name = profile?.display_name || profile?.name || 'Unknown';
    const avatar = profile?.picture || '';
    return renderUserMention(
      pubkey,
      {
        username: name,
        avatarUrl: avatar,
      },
      { withBackground: false }
    );
  }

  /**
   * Create fallback element when zap data is missing
   */
  private static createFallbackElement(note: ProcessedNote): HTMLElement {
    const element = document.createElement('div');
    element.className = 'note-card note-card--zap-receipt note-card--error';
    if (note.id) element.dataset.eventId = note.id;

    element.innerHTML = `
      <div class="zap-receipt zap-receipt--error">
        <span class="zap-receipt__icon">⚡</span>
        <span class="zap-receipt__text">Zap Receipt</span>
        <small>Could not parse zap data</small>
      </div>
    `;

    return element;
  }
}
