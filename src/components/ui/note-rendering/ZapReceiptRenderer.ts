/**
 * ZapReceiptRenderer - Renders kind:9735 zap receipts
 * Displays zap information in a visually distinct card
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { UserProfileService } from '../../../services/UserProfileService';
import { renderUserMention, setupUserMentionHandlers } from '../../../helpers/UserMentionHelper';
import { escapeHtml } from '../../../helpers/escapeHtml';

export class ZapReceiptRenderer {
  private static profileService = UserProfileService.getInstance();

  /**
   * Render zap receipt element
   */
  static render(note: ProcessedNote, _opts: NoteUIOptions): HTMLElement {
    const zapData = note.zapReceiptData;
    if (!zapData) {
      return ZapReceiptRenderer.createFallbackElement(note);
    }

    const element = document.createElement('div');
    element.className = 'note-card note-card--zap-receipt';
    if (note.id) element.dataset.eventId = note.id;

    // Format amount with thousand separators
    const formattedAmount = zapData.amountSats.toLocaleString();

    // Get sender profile and render mention
    let senderMention = '<span class="zap-receipt__anonymous">Anonymous</span>';
    if (zapData.senderPubkey) {
      const senderProfile = ZapReceiptRenderer.profileService.getCachedProfile(zapData.senderPubkey);
      const senderName = senderProfile?.display_name || senderProfile?.name || 'Unknown';
      const senderAvatar = senderProfile?.picture || '';
      senderMention = renderUserMention(zapData.senderPubkey, {
        username: senderName,
        avatarUrl: senderAvatar
      }, { withBackground: false });
    }

    // Get recipient profile and render mention
    const recipientProfile = ZapReceiptRenderer.profileService.getCachedProfile(zapData.recipientPubkey);
    const recipientName = recipientProfile?.display_name || recipientProfile?.name || 'Unknown';
    const recipientAvatar = recipientProfile?.picture || '';
    const recipientMention = renderUserMention(zapData.recipientPubkey, {
      username: recipientName,
      avatarUrl: recipientAvatar
    }, { withBackground: false });

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

    // Setup click handlers and hover cards
    setupUserMentionHandlers(element);

    return element;
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
