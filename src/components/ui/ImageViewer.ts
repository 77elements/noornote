/**
 * ImageViewer Component
 * Full-screen image viewer with zoom, navigation, and controls
 *
 * Features:
 * - Full-screen overlay with semi-transparent background
 * - Keyboard navigation (ESC, Arrow Left/Right)
 * - Mouse controls (click background to close)
 * - Zoom in/out functionality
 * - Next/Previous navigation for multiple images
 * - Download and Share as Quoted Repost (preserves NSFW tags)
 */

import { ToastService } from '../../services/ToastService';
import { PlatformService } from '../../services/PlatformService';

// Conditionally import Tauri APIs (only available in Tauri build)
let tauriSave: typeof import('@tauri-apps/plugin-dialog').save | null = null;
let tauriWriteFile: typeof import('@tauri-apps/plugin-fs').writeFile | null = null;
let tauriFetch: typeof import('@tauri-apps/plugin-http').fetch | null = null;

const platform = PlatformService.getInstance();

// Load Tauri APIs if available
if (platform.isTauri) {
  import('@tauri-apps/plugin-dialog').then(mod => { tauriSave = mod.save; });
  import('@tauri-apps/plugin-fs').then(mod => { tauriWriteFile = mod.writeFile; });
  import('@tauri-apps/plugin-http').then(mod => { tauriFetch = mod.fetch; });
}

export interface ImageViewerOptions {
  images: string[]; // Array of image URLs
  initialIndex?: number; // Which image to show first (default: 0)
  sourceEvent?: {
    eventId: string;
    authorPubkey: string;
    isNSFW: boolean;
  };
}

export class ImageViewer {
  private container: HTMLElement | null = null;
  private images: string[] = [];
  private currentIndex: number = 0;
  private zoomLevel: number = 1;
  private isDragging: boolean = false;
  private dragStart = { x: 0, y: 0 };
  private imagePosition = { x: 0, y: 0 };
  private sourceEvent?: { eventId: string; authorPubkey: string; isNSFW: boolean };

  constructor() {
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleBackgroundClick = this.handleBackgroundClick.bind(this);
  }

  /**
   * Open the image viewer
   */
  public open(options: ImageViewerOptions): void {
    this.images = options.images;
    this.currentIndex = options.initialIndex || 0;
    this.zoomLevel = 1;
    this.imagePosition = { x: 0, y: 0 };
    this.sourceEvent = options.sourceEvent;

    this.render();
    this.attachEventListeners();
  }

  /**
   * Close the image viewer
   */
  public close(): void {
    this.detachEventListeners();
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }

  /**
   * Navigate to next image
   */
  private next(): void {
    if (this.currentIndex < this.images.length - 1) {
      this.currentIndex++;
      this.zoomLevel = 1;
      this.imagePosition = { x: 0, y: 0 };
      this.updateImage();
    }
  }

  /**
   * Navigate to previous image
   */
  private previous(): void {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.zoomLevel = 1;
      this.imagePosition = { x: 0, y: 0 };
      this.updateImage();
    }
  }

  /**
   * Zoom in
   */
  private zoomIn(): void {
    this.zoomLevel = Math.min(this.zoomLevel + 0.5, 5); // Max 5x zoom
    this.updateImage();
  }

  /**
   * Zoom out
   */
  private zoomOut(): void {
    this.zoomLevel = Math.max(this.zoomLevel - 0.5, 1); // Min 1x zoom
    this.imagePosition = { x: 0, y: 0 }; // Reset position when zooming out
    this.updateImage();
  }

  /**
   * Reset zoom to 1x
   */
  private resetZoom(): void {
    this.zoomLevel = 1;
    this.imagePosition = { x: 0, y: 0 };
    this.updateImage();
  }

  /**
   * Download current image
   */
  private async download(): Promise<void> {
    const imageUrl = this.images[this.currentIndex];
    const defaultFileName = imageUrl.split('/').pop() || 'image.jpg';

    try {
      // Check if running in Tauri
      if (platform.isTauri && tauriSave && tauriWriteFile && tauriFetch) {
        // Tauri: Use Tauri HTTP client (bypasses CORS), show save dialog, and write file
        const response = await tauriFetch(imageUrl, { method: 'GET' });
        const arrayBuffer = await response.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        const filePath = await tauriSave({
          defaultPath: defaultFileName,
          filters: [{
            name: 'Images',
            extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp']
          }]
        });

        if (filePath) {
          await tauriWriteFile(filePath, uint8Array);
          ToastService.show('Image saved successfully', 'success');
        }
      } else {
        // Web: Use traditional browser download method
        const response = await fetch(imageUrl);
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = defaultFileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      }
    } catch (error) {
      console.error('Failed to download image:', error);
      ToastService.show('Failed to save image', 'error');
    }
  }

  /**
   * Share image as Quoted Repost
   * Extracts current image URL and creates a new note with:
   * - The image itself (URL)
   * - Attribution: "Image via nostr:npub..." (user mention)
   * - Source link to original event
   * - User can add their own text above
   * Preserves NSFW tags for security (NIP-36)
   */
  private async share(): Promise<void> {
    if (!this.sourceEvent) {
      ToastService.show('Cannot share: Image source not available', 'error');
      return;
    }

    try {
      const { encodeNpub } = await import('../../services/NostrToolsAdapter');
      const { PostNoteModal } = await import('../post/PostNoteModal');

      // Get current image URL
      const currentImageUrl = this.images[this.currentIndex];

      // Convert author pubkey to npub mention (nostr:npub format)
      const npub = encodeNpub(this.sourceEvent.authorPubkey);
      const mentionTag = `nostr:${npub}`;

      // Generate nostr.ae URL for the original event
      const sourceUrl = `https://nostr.ae/${this.sourceEvent.eventId}`;

      // Build content: Image URL + attribution with user mention + source link
      // Format: <image-url>\nImage via nostr:npub... https://nostr.ae/...
      let content = '';
      if (this.sourceEvent.isNSFW) {
        content += '⚠️ NSFW Content\n\n';
      }
      content += `${currentImageUrl}\nImage via ${mentionTag} ${sourceUrl}`;

      // Open PostNoteModal with pre-filled content
      PostNoteModal.getInstance().show(content);

      // Close ImageViewer after opening editor
      this.close();
    } catch (error) {
      console.error('Failed to share image:', error);
      ToastService.show('Failed to open share editor', 'error');
    }
  }

  /**
   * Render the viewer
   */
  private render(): void {
    this.container = document.createElement('div');
    this.container.className = 'image-viewer';
    this.container.innerHTML = `
      <div class="image-viewer__background"></div>
      <div class="image-viewer__content">
        <div class="image-viewer__controls">
          <button class="image-viewer__btn image-viewer__btn--zoom-out" title="Zoom Out" aria-label="Zoom Out">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"></circle>
              <path d="M21 21l-4.35-4.35"></path>
              <line x1="8" y1="11" x2="14" y2="11"></line>
            </svg>
          </button>
          <button class="image-viewer__btn image-viewer__btn--zoom-in" title="Zoom In" aria-label="Zoom In">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"></circle>
              <path d="M21 21l-4.35-4.35"></path>
              <line x1="11" y1="8" x2="11" y2="14"></line>
              <line x1="8" y1="11" x2="14" y2="11"></line>
            </svg>
          </button>
          <button class="image-viewer__btn image-viewer__btn--reset" title="Reset Zoom" aria-label="Reset Zoom">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 4v6h6"></path>
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
            </svg>
          </button>
          <button class="image-viewer__btn image-viewer__btn--download" title="Download" aria-label="Download">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
          </button>
          <button class="image-viewer__btn image-viewer__btn--share" title="Share as Quote" aria-label="Share">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="18" cy="5" r="3"></circle>
              <circle cx="6" cy="12" r="3"></circle>
              <circle cx="18" cy="19" r="3"></circle>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
            </svg>
          </button>
          <button class="image-viewer__btn image-viewer__btn--close" title="Close (ESC)" aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div class="image-viewer__image-container">
          <img class="image-viewer__image" src="${this.images[this.currentIndex]}" alt="Full screen image">
        </div>
        ${this.images.length > 1 ? this.renderNavigation() : ''}
      </div>
    `;

    document.body.appendChild(this.container);

    // Attach button event listeners
    this.attachControlListeners();
    this.attachImageDragListeners();
  }

  /**
   * Render navigation buttons (only if multiple images)
   */
  private renderNavigation(): string {
    return `
      <button class="image-viewer__nav image-viewer__nav--prev ${this.currentIndex === 0 ? 'disabled' : ''}"
              aria-label="Previous image"
              ${this.currentIndex === 0 ? 'disabled' : ''}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"></polyline>
        </svg>
      </button>
      <button class="image-viewer__nav image-viewer__nav--next ${this.currentIndex === this.images.length - 1 ? 'disabled' : ''}"
              aria-label="Next image"
              ${this.currentIndex === this.images.length - 1 ? 'disabled' : ''}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </button>
      <div class="image-viewer__counter">${this.currentIndex + 1} / ${this.images.length}</div>
    `;
  }

  /**
   * Update image and navigation state
   */
  private updateImage(): void {
    if (!this.container) return;

    const img = this.container.querySelector('.image-viewer__image') as HTMLImageElement;
    if (img) {
      img.src = this.images[this.currentIndex];
      img.style.transform = `scale(${this.zoomLevel}) translate(${this.imagePosition.x}px, ${this.imagePosition.y}px)`;
    }

    // Update navigation if multiple images
    if (this.images.length > 1) {
      const prevBtn = this.container.querySelector('.image-viewer__nav--prev') as HTMLButtonElement;
      const nextBtn = this.container.querySelector('.image-viewer__nav--next') as HTMLButtonElement;
      const counter = this.container.querySelector('.image-viewer__counter');

      if (prevBtn) {
        prevBtn.disabled = this.currentIndex === 0;
        prevBtn.classList.toggle('disabled', this.currentIndex === 0);
      }

      if (nextBtn) {
        nextBtn.disabled = this.currentIndex === this.images.length - 1;
        nextBtn.classList.toggle('disabled', this.currentIndex === this.images.length - 1);
      }

      if (counter) {
        counter.textContent = `${this.currentIndex + 1} / ${this.images.length}`;
      }
    }
  }

  /**
   * Attach control button listeners
   */
  private attachControlListeners(): void {
    if (!this.container) return;

    const zoomInBtn = this.container.querySelector('.image-viewer__btn--zoom-in');
    const zoomOutBtn = this.container.querySelector('.image-viewer__btn--zoom-out');
    const resetBtn = this.container.querySelector('.image-viewer__btn--reset');
    const downloadBtn = this.container.querySelector('.image-viewer__btn--download');
    const shareBtn = this.container.querySelector('.image-viewer__btn--share');
    const closeBtn = this.container.querySelector('.image-viewer__btn--close');

    zoomInBtn?.addEventListener('click', () => this.zoomIn());
    zoomOutBtn?.addEventListener('click', () => this.zoomOut());
    resetBtn?.addEventListener('click', () => this.resetZoom());
    downloadBtn?.addEventListener('click', () => this.download());
    shareBtn?.addEventListener('click', () => this.share());
    closeBtn?.addEventListener('click', () => this.close());

    // Navigation buttons
    const prevBtn = this.container.querySelector('.image-viewer__nav--prev');
    const nextBtn = this.container.querySelector('.image-viewer__nav--next');

    prevBtn?.addEventListener('click', () => this.previous());
    nextBtn?.addEventListener('click', () => this.next());
  }

  /**
   * Attach image drag listeners for panning when zoomed
   */
  private attachImageDragListeners(): void {
    if (!this.container) return;

    const img = this.container.querySelector('.image-viewer__image') as HTMLImageElement;
    if (!img) return;

    img.addEventListener('mousedown', (e: MouseEvent) => {
      if (this.zoomLevel > 1) {
        this.isDragging = true;
        this.dragStart = {
          x: e.clientX - this.imagePosition.x,
          y: e.clientY - this.imagePosition.y
        };
        img.style.cursor = 'grabbing';
      }
    });

    document.addEventListener('mousemove', (e: MouseEvent) => {
      if (this.isDragging && this.zoomLevel > 1) {
        this.imagePosition = {
          x: e.clientX - this.dragStart.x,
          y: e.clientY - this.dragStart.y
        };
        this.updateImage();
      }
    });

    document.addEventListener('mouseup', () => {
      if (this.isDragging) {
        this.isDragging = false;
        if (img) {
          img.style.cursor = this.zoomLevel > 1 ? 'grab' : 'default';
        }
      }
    });
  }

  /**
   * Attach global event listeners
   */
  private attachEventListeners(): void {
    document.addEventListener('keydown', this.handleKeyDown);

    // Click on content area (but not on image or controls) closes viewer
    const content = this.container?.querySelector('.image-viewer__content');
    content?.addEventListener('click', (e: Event) => {
      // Only close if clicked directly on content (not on child elements like image/controls)
      if (e.target === content) {
        this.handleBackgroundClick();
      }
    });
  }

  /**
   * Detach global event listeners
   */
  private detachEventListeners(): void {
    document.removeEventListener('keydown', this.handleKeyDown);
  }

  /**
   * Handle keyboard shortcuts
   */
  private handleKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'Escape':
        this.close();
        break;
      case 'ArrowLeft':
        this.previous();
        break;
      case 'ArrowRight':
        this.next();
        break;
      case '+':
      case '=':
        this.zoomIn();
        break;
      case '-':
        this.zoomOut();
        break;
      case '0':
        this.resetZoom();
        break;
    }
  }

  /**
   * Handle background click to close
   */
  private handleBackgroundClick(): void {
    this.close();
  }
}

// Singleton instance
let imageViewerInstance: ImageViewer | null = null;

/**
 * Get or create ImageViewer instance
 */
export function getImageViewer(): ImageViewer {
  if (!imageViewerInstance) {
    imageViewerInstance = new ImageViewer();
  }
  return imageViewerInstance;
}
