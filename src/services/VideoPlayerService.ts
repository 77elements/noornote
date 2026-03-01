/**
 * VideoPlayerService
 * Native HTML5 video player with fullscreen support
 * - Browser: Uses native Fullscreen API (real fullscreen)
 * - Tauri: Falls back to CSS-based fullscreen (WebView limitation)
 */

import { PlatformService } from './PlatformService';
import { ToastService } from './ToastService';
import { downloadMedia } from '../helpers/downloadMedia';

export class VideoPlayerService {
  private static instance: VideoPlayerService | null = null;
  private fullscreenVideo: HTMLVideoElement | null = null;
  private readonly isBrowser: boolean;

  private constructor() {
    this.isBrowser = PlatformService.getInstance().isBrowser;
  }

  public static getInstance(): VideoPlayerService {
    if (!VideoPlayerService.instance) {
      VideoPlayerService.instance = new VideoPlayerService();
    }
    return VideoPlayerService.instance;
  }

  /**
   * Toggle fullscreen for video
   * Browser: Uses native Fullscreen API (real fullscreen)
   * Tauri: CSS-based fullscreen (moves video to body to escape containment)
   */
  private toggleFullscreen(video: HTMLVideoElement): void {
    if (this.isBrowser) {
      this.toggleNativeFullscreen(video);
    } else {
      this.toggleCssFullscreen(video);
    }
  }

  /**
   * Native Fullscreen API (Browser only)
   */
  private toggleNativeFullscreen(video: HTMLVideoElement): void {
    if (document.fullscreenElement === video) {
      document.exitFullscreen();
    } else {
      video.requestFullscreen().catch(() => {
        // Fallback to CSS if native fails
        this.toggleCssFullscreen(video);
      });
    }
  }

  /**
   * CSS-based fullscreen (Tauri fallback)
   * Moves video to body to escape CSS containment in .primary-content
   */
  private toggleCssFullscreen(video: HTMLVideoElement): void {
    const fsButton = (video as any)._fsButton;
    const dlButton = (video as any)._dlButton;

    if (this.fullscreenVideo === video) {
      // Exit fullscreen
      video.classList.remove('video-fullscreen-mode');
      if (fsButton) {
        fsButton.classList.remove('video-fullscreen-btn-active');
      }
      if (dlButton) {
        dlButton.classList.remove('video-download-btn-active');
      }
      document.body.style.overflow = '';

      // Move video back to original position
      const originalParent = (video as any)._originalParent;
      const originalNextSibling = (video as any)._originalNextSibling;
      const originalButtonParent = (video as any)._originalButtonParent;
      const originalDlButtonParent = (video as any)._originalDlButtonParent;

      if (originalParent) {
        if (originalNextSibling && originalNextSibling.parentNode === originalParent) {
          originalParent.insertBefore(video, originalNextSibling);
        } else {
          originalParent.appendChild(video);
        }

        // Move buttons back to wrapper
        if (fsButton && originalButtonParent) {
          originalButtonParent.appendChild(fsButton);
        }
        if (dlButton && originalDlButtonParent) {
          originalDlButtonParent.appendChild(dlButton);
        }

        // Clean up stored references
        delete (video as any)._originalParent;
        delete (video as any)._originalNextSibling;
        delete (video as any)._originalButtonParent;
        delete (video as any)._originalDlButtonParent;
      }

      this.fullscreenVideo = null;
    } else {
      // Enter fullscreen
      // Store original positions before moving
      (video as any)._originalParent = video.parentElement;
      (video as any)._originalNextSibling = video.nextSibling;
      (video as any)._originalButtonParent = fsButton ? fsButton.parentElement : null;
      (video as any)._originalDlButtonParent = dlButton ? dlButton.parentElement : null;

      // Move video to end of body (escapes CSS containment)
      document.body.appendChild(video);

      // Move buttons to body as well (so they stay visible with video)
      if (fsButton) {
        document.body.appendChild(fsButton);
      }
      if (dlButton) {
        document.body.appendChild(dlButton);
      }

      video.classList.add('video-fullscreen-mode');
      if (fsButton) {
        fsButton.classList.add('video-fullscreen-btn-active');
      }
      if (dlButton) {
        dlButton.classList.add('video-download-btn-active');
      }
      document.body.style.overflow = 'hidden';
      this.fullscreenVideo = video;

      // Exit fullscreen on Escape key
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && this.fullscreenVideo) {
          this.toggleCssFullscreen(this.fullscreenVideo);
          document.removeEventListener('keydown', handleEscape);
        }
      };
      document.addEventListener('keydown', handleEscape);
    }
  }

  /**
   * Add fullscreen and download buttons to native video controls
   */
  public initializeForContainer(container: HTMLElement): void {
    const videos = container.querySelectorAll<HTMLVideoElement>('video.note-video');
    videos.forEach(video => {
      // Skip if already initialized
      if (video.dataset.fsInitialized) return;
      video.dataset.fsInitialized = 'true';

      // Create fullscreen button
      const fsButton = document.createElement('button');
      fsButton.className = 'video-fullscreen-btn';
      fsButton.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
          <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
        </svg>
      `;
      fsButton.title = 'Fullscreen (Double-click video or press Escape to exit)';
      fsButton.style.cssText = `
        position: absolute;
        top: 10px;
        right: 10px;
        background: var(--alpha-medium);
        border: none;
        border-radius: 4px;
        padding: 8px;
        cursor: pointer;
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
      `;

      fsButton.addEventListener('mouseenter', () => {
        fsButton.style.background = 'var(--alpha-medium)';
      });

      fsButton.addEventListener('mouseleave', () => {
        fsButton.style.background = 'var(--alpha-medium)';
      });

      fsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleFullscreen(video);
      });

      // Create download button
      const dlButton = document.createElement('button');
      dlButton.className = 'video-download-btn';
      dlButton.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
      `;
      dlButton.title = 'Download';
      dlButton.style.cssText = `
        position: absolute;
        top: 10px;
        right: 50px;
        background: var(--alpha-medium);
        border: none;
        border-radius: 4px;
        padding: 8px;
        cursor: pointer;
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s;
      `;

      dlButton.addEventListener('click', async (e) => {
        e.stopPropagation();
        const src = video.currentSrc || video.src;
        if (!src) return;
        const defaultFileName = src.split('/').pop()?.split('?')[0] || 'video.mp4';
        try {
          await downloadMedia(src, defaultFileName);
        } catch {
          ToastService.show('Failed to save video', 'error');
        }
      });

      // Also allow double-click on video to toggle fullscreen
      video.addEventListener('dblclick', () => {
        this.toggleFullscreen(video);
      });

      // Pause video when scrolled out of viewport
      const visibilityObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting && !video.paused) {
              video.pause();
            }
          });
        },
        { threshold: 0 }
      );
      visibilityObserver.observe(video);
      (video as any)._visibilityObserver = visibilityObserver;

      // Position video relatively and add buttons
      const wrapper = video.parentElement;
      if (wrapper) {
        wrapper.style.position = 'relative';
        wrapper.appendChild(fsButton);
        wrapper.appendChild(dlButton);

        // Store button references for cleanup
        (video as any)._fsButton = fsButton;
        (video as any)._dlButton = dlButton;
      }
    });

    // Add CSS for fullscreen mode (if not already added)
    if (!document.getElementById('video-fullscreen-css')) {
      const style = document.createElement('style');
      style.id = 'video-fullscreen-css';
      style.textContent = `
        .video-fullscreen-mode {
          position: fixed !important;
          top: 0 !important;
          left: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          max-width: 100vw !important;
          max-height: 100vh !important;
          z-index: 9999 !important;
          background: black !important;
          object-fit: contain !important;
        }
        .video-fullscreen-btn-active {
          position: fixed !important;
          top: 20px !important;
          right: 20px !important;
          bottom: auto !important;
          z-index: 10000 !important;
        }
        .video-download-btn-active {
          position: fixed !important;
          top: 20px !important;
          right: 60px !important;
          bottom: auto !important;
          z-index: 10000 !important;
        }
        body:has(.video-fullscreen-mode) {
          overflow: hidden !important;
        }
        body:has(.video-fullscreen-mode) * {
          scrollbar-width: none !important;
        }
        body:has(.video-fullscreen-mode) *::-webkit-scrollbar {
          display: none !important;
        }
      `;
      document.head.appendChild(style);
    }
  }

  /**
   * Cleanup
   */
  public cleanupForContainer(container: HTMLElement): void {
    const videos = container.querySelectorAll<HTMLVideoElement>('video.note-video');
    videos.forEach(video => {
      const fsButton = (video as any)._fsButton;
      if (fsButton) {
        fsButton.remove();
        delete (video as any)._fsButton;
      }
      const dlButton = (video as any)._dlButton;
      if (dlButton) {
        dlButton.remove();
        delete (video as any)._dlButton;
      }
      const visibilityObserver = (video as any)._visibilityObserver as IntersectionObserver | undefined;
      if (visibilityObserver) {
        visibilityObserver.disconnect();
        delete (video as any)._visibilityObserver;
      }
      video.classList.remove('video-fullscreen-mode');
      delete video.dataset.fsInitialized;
    });

    if (this.fullscreenVideo) {
      document.body.style.overflow = '';
      this.fullscreenVideo = null;
    }
  }
}

export function getVideoPlayerService(): VideoPlayerService {
  return VideoPlayerService.getInstance();
}
