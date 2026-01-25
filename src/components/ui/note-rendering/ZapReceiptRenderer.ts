/**
 * ZapReceiptRenderer - Renders kind:9735 zap receipts
 * Displays zap information in a visually distinct card
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { UserProfileService } from '../../../services/UserProfileService';
import { Router } from '../../../services/Router';
import { encodeNpub } from '../../../services/NostrToolsAdapter';

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

    // Get sender profile
    const senderProfile = zapData.senderPubkey
      ? ZapReceiptRenderer.profileService.getCachedProfile(zapData.senderPubkey)
      : null;
    const senderName = senderProfile?.display_name || senderProfile?.name || 'Anonymous';
    const senderPicture = senderProfile?.picture || '';

    // Get recipient profile
    const recipientProfile = ZapReceiptRenderer.profileService.getCachedProfile(zapData.recipientPubkey);
    const recipientName = recipientProfile?.display_name || recipientProfile?.name || 'Unknown';

    // Build HTML
    element.innerHTML = `
      <div class="zap-receipt">
        <div class="zap-receipt__header">
          <span class="zap-receipt__icon">⚡</span>
          <span class="zap-receipt__amount">${formattedAmount} sats</span>
        </div>
        <div class="zap-receipt__details">
          <div class="zap-receipt__sender">
            ${senderPicture ? `<img src="${senderPicture}" alt="" class="zap-receipt__avatar">` : '<div class="zap-receipt__avatar zap-receipt__avatar--placeholder"></div>'}
            <span class="zap-receipt__name zap-receipt__name--sender" data-pubkey="${zapData.senderPubkey || ''}">${senderName}</span>
          </div>
          <span class="zap-receipt__arrow">→</span>
          <span class="zap-receipt__name zap-receipt__name--recipient" data-pubkey="${zapData.recipientPubkey}">${recipientName}</span>
        </div>
        ${zapData.message ? `<div class="zap-receipt__message">"${ZapReceiptRenderer.escapeHtml(zapData.message)}"</div>` : ''}
      </div>
    `;

    // Add click handlers for profile navigation
    ZapReceiptRenderer.setupClickHandlers(element);

    return element;
  }

  /**
   * Setup click handlers for profile links
   */
  private static setupClickHandlers(element: HTMLElement): void {
    const router = Router.getInstance();

    element.querySelectorAll('.zap-receipt__name[data-pubkey]').forEach(el => {
      const pubkey = (el as HTMLElement).dataset.pubkey;
      if (pubkey) {
        (el as HTMLElement).style.cursor = 'pointer';
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const npub = encodeNpub(pubkey);
          router.navigate(`/profile/${npub}`);
        });
      }
    });

    element.querySelectorAll('.zap-receipt__avatar').forEach(el => {
      const nameEl = el.nextElementSibling as HTMLElement;
      const pubkey = nameEl?.dataset.pubkey;
      if (pubkey) {
        (el as HTMLElement).style.cursor = 'pointer';
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const npub = encodeNpub(pubkey);
          router.navigate(`/profile/${npub}`);
        });
      }
    });
  }

  /**
   * Escape HTML to prevent XSS
   */
  private static escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
