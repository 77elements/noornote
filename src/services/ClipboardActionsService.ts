/**
 * ClipboardActionsService
 * Centralized clipboard operations with toast feedback and visual indicators
 *
 * Single Responsibility: Handle all clipboard copy operations app-wide
 * Used by: NoteMenu, ProfileView, AnalyticsModal, ImageViewer
 */

import { hexToNpub } from '../helpers/nip19';
import { encodeNevent } from './NostrToolsAdapter';
import { ToastService } from './ToastService';
import { _ } from '../i18n';

export class ClipboardActionsService {
  private static instance: ClipboardActionsService;

  private constructor() {}

  public static getInstance(): ClipboardActionsService {
    if (!ClipboardActionsService.instance) {
      ClipboardActionsService.instance = new ClipboardActionsService();
    }
    return ClipboardActionsService.instance;
  }

  /**
   * Copy event ID to clipboard (nevent format).
   * Embeds the author pubkey when known so other clients (and our own
   * PostService when this nevent is later quoted) get a complete tag set.
   * Relay hints make the nevent resolvable even when the receiving client
   * is not connected to a relay that carries the event.
   * @param eventId - Hex event ID
   * @param authorPubkey - Hex author pubkey (optional but strongly recommended)
   * @param relays - Relay hints to embed (optional, keep ≤ 3)
   * @param showToast - Show success toast (default: true)
   */
  public async copyEventId(
    eventId: string,
    authorPubkey?: string,
    relays?: string[],
    showToast: boolean = true
  ): Promise<boolean> {
    try {
      const nevent = encodeNevent(eventId, relays, authorPubkey || undefined);
      await navigator.clipboard.writeText(nevent);

      if (showToast) {
        ToastService.show(_('Event ID copied'), 'success');
      }

      return true;
    } catch (error) {
      console.error('Failed to copy event ID:', error);
      ToastService.show(_('Failed to copy event ID'), 'error');
      return false;
    }
  }

  /**
   * Copy user pubkey to clipboard (npub format)
   * @param pubkey - Hex pubkey
   * @param showToast - Show success toast (default: true)
   */
  public async copyUserPubkey(
    pubkey: string,
    showToast: boolean = true
  ): Promise<boolean> {
    try {
      const npub = hexToNpub(pubkey);
      if (!npub) {
        throw new Error('Invalid pubkey');
      }

      await navigator.clipboard.writeText(npub);

      if (showToast) {
        ToastService.show(_('User ID copied'), 'success');
      }

      return true;
    } catch (error) {
      console.error('Failed to copy user ID:', error);
      ToastService.show(_('Failed to copy user ID'), 'error');
      return false;
    }
  }

  /**
   * Generic copy text with optional toast feedback
   * @param text - Text to copy
   * @param label - Label for success message (e.g., "Username", "Link")
   * @param showToast - Show success toast (default: true)
   */
  public async copyText(
    text: string,
    label: string = _('Text'),
    showToast: boolean = true
  ): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);

      if (showToast) {
        ToastService.show(_('%s copied', label), 'success');
      }

      return true;
    } catch (error) {
      console.error(`Failed to copy ${label}:`, error);
      ToastService.show(_('Failed to copy %s', label), 'error');
      return false;
    }
  }

  /**
   * Add visual feedback to a button element after successful copy
   * @param button - Button element to animate
   * @param duration - Duration in ms (default: 2000)
   */
  public addVisualFeedback(button: HTMLElement, duration: number = 2000): void {
    button.classList.add('copied');
    setTimeout(() => {
      button.classList.remove('copied');
    }, duration);
  }
}
