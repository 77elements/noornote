/**
 * ImageClickHandler — Document-delegated image click handler
 *
 * INVIOLABLE RULE (enforced by /build-validate):
 *   A click on `.note-image--clickable` ALWAYS opens the lightbox, regardless
 *   of nesting depth or render path (top-level note, quote box, repost,
 *   article preview, etc.). One delegated listener on document.body is the
 *   single source of truth — there are NO per-container init calls.
 *
 *   Any other click handler in note/quote/preview renderers MUST early-return
 *   when `target.closest('.note-image--clickable, .note-media, video')` is
 *   truthy, otherwise it would pre-empt this handler.
 */

import { getImageViewer } from './ImageViewer';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

export class ImageClickHandler {
  private static instance: ImageClickHandler | null = null;
  private initialized = false;

  private constructor() {
    this.handleDelegatedClick = this.handleDelegatedClick.bind(this);
  }

  public static getInstance(): ImageClickHandler {
    if (!ImageClickHandler.instance) {
      ImageClickHandler.instance = new ImageClickHandler();
    }
    return ImageClickHandler.instance;
  }

  /**
   * Register the single delegated click listener on document.body.
   * Idempotent — call once at app startup (App.ts).
   */
  public init(): void {
    if (this.initialized) return;
    this.initialized = true;
    document.body.addEventListener('click', this.handleDelegatedClick);
  }

  private handleDelegatedClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const img = target.closest('.note-image--clickable') as HTMLElement | null;
    if (!img) return;

    const mediaContainer = img.closest('.note-media');
    if (!mediaContainer) return;

    // NSFW gate
    if (mediaContainer.classList.contains('nsfw-media')) {
      const sensitiveSettings = PerAccountLocalStorage.getInstance().get<{ displayNSFW: boolean }>(
        StorageKeys.SENSITIVE_MEDIA,
        { displayNSFW: false }
      );
      if (!sensitiveSettings.displayNSFW) return;
    }

    const imageUrlsJson = mediaContainer.getAttribute('data-image-urls');
    if (!imageUrlsJson) return;

    let imageUrls: string[] = [];
    try {
      imageUrls = JSON.parse(decodeURIComponent(imageUrlsJson));
    } catch (error) {
      console.debug('ImageClickHandler: failed to parse data-image-urls', error);
      return;
    }

    const imageIndex = parseInt(img.getAttribute('data-image-index') || '0', 10);
    const eventId = mediaContainer.getAttribute('data-event-id');
    const authorPubkey = mediaContainer.getAttribute('data-author-pubkey');
    const isNSFWAttr = mediaContainer.getAttribute('data-is-nsfw');

    // Stop bubbling so parent click handlers (e.g. quote-box SNV navigation)
    // never fire for image clicks. The image-click rule has absolute priority.
    event.stopPropagation();

    const viewer = getImageViewer();
    const options: Parameters<typeof viewer.open>[0] = {
      images: imageUrls,
      initialIndex: imageIndex
    };
    if (eventId && authorPubkey) {
      options.sourceEvent = {
        eventId,
        authorPubkey,
        isNSFW: isNSFWAttr === 'true'
      };
    }
    viewer.open(options);
  }
}

export function getImageClickHandler(): ImageClickHandler {
  return ImageClickHandler.getInstance();
}
