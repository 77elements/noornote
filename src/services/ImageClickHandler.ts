/**
 * ImageClickHandler Service
 * Manages click events on note images and opens ImageViewer
 *
 * Responsibilities:
 * - Attach click handlers to all .note-image elements
 * - Respect NSFW settings (no fullscreen for blocked NSFW images)
 * - Extract image URLs from parent container
 * - Open ImageViewer with correct image index
 */

import { getImageViewer } from '../components/ui/ImageViewer';

export class ImageClickHandler {
  private static instance: ImageClickHandler | null = null;

  private constructor() {
    this.handleImageClick = this.handleImageClick.bind(this);
  }

  public static getInstance(): ImageClickHandler {
    if (!ImageClickHandler.instance) {
      ImageClickHandler.instance = new ImageClickHandler();
    }
    return ImageClickHandler.instance;
  }

  /**
   * Initialize click handlers for all images in a container
   */
  public initializeForContainer(container: HTMLElement): void {
    const images = container.querySelectorAll('.note-image--clickable');
    images.forEach(img => {
      img.addEventListener('click', this.handleImageClick);
    });
  }

  /**
   * Remove click handlers from container (cleanup)
   */
  public cleanupForContainer(container: HTMLElement): void {
    const images = container.querySelectorAll('.note-image--clickable');
    images.forEach(img => {
      img.removeEventListener('click', this.handleImageClick);
    });
  }

  /**
   * Handle image click event
   */
  private handleImageClick(event: Event): void {
    const img = event.currentTarget as HTMLElement;
    const mediaContainer = img.closest('.note-media, .note-media-inline');

    if (!mediaContainer) return;

    // Check if this is NSFW content
    const isNSFW = mediaContainer.classList.contains('nsfw-media');

    if (isNSFW) {
      // Check if sensitive media display is enabled (from localStorage)
      try {
        const sensitiveMediaSettings = localStorage.getItem('noornote_sensitive_media');
        const displayNSFW = sensitiveMediaSettings
          ? JSON.parse(sensitiveMediaSettings).displayNSFW
          : false;

        if (!displayNSFW) {
          // Don't open viewer for blocked NSFW images
          return;
        }
      } catch (error) {
        console.error('Failed to read sensitive media settings:', error);
        // Default: don't show NSFW
        return;
      }
    }

    // Extract image URLs from data attribute
    const imageUrlsJson = mediaContainer.getAttribute('data-image-urls');
    if (!imageUrlsJson) return;

    let imageUrls: string[] = [];
    try {
      imageUrls = JSON.parse(decodeURIComponent(imageUrlsJson));
    } catch (error) {
      console.error('Failed to parse image URLs:', error);
      return;
    }

    // Get clicked image index
    const imageIndex = parseInt(img.getAttribute('data-image-index') || '0', 10);

    // Extract source event data (for Share feature)
    const eventId = mediaContainer.getAttribute('data-event-id');
    const authorPubkey = mediaContainer.getAttribute('data-author-pubkey');
    const isNSFWAttr = mediaContainer.getAttribute('data-is-nsfw');

    // Open image viewer
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

// Export singleton getter
export function getImageClickHandler(): ImageClickHandler {
  return ImageClickHandler.getInstance();
}
