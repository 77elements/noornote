/**
 * VideoPlayerService
 * Native HTML5 video player with CSS-based fullscreen (Tauri-compatible)
 */

export class VideoPlayerService {
  private static instance: VideoPlayerService | null = null;
  private fullscreenVideo: HTMLVideoElement | null = null;

  private constructor() {}

  public static getInstance(): VideoPlayerService {
    if (!VideoPlayerService.instance) {
      VideoPlayerService.instance = new VideoPlayerService();
    }
    return VideoPlayerService.instance;
  }

  /**
   * Toggle CSS fullscreen for video
   */
  private toggleFullscreen(video: HTMLVideoElement): void {
    const fsButton = (video as any)._fsButton;

    if (this.fullscreenVideo === video) {
      // Exit fullscreen
      video.classList.remove('video-fullscreen-mode');
      if (fsButton) {
        fsButton.classList.remove('video-fullscreen-btn-active');
      }
      document.body.style.overflow = '';
      this.fullscreenVideo = null;
    } else {
      // Enter fullscreen
      video.classList.add('video-fullscreen-mode');
      if (fsButton) {
        fsButton.classList.add('video-fullscreen-btn-active');
      }
      document.body.style.overflow = 'hidden';
      this.fullscreenVideo = video;

      // Exit fullscreen on Escape key
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && this.fullscreenVideo) {
          this.toggleFullscreen(this.fullscreenVideo);
          document.removeEventListener('keydown', handleEscape);
        }
      };
      document.addEventListener('keydown', handleEscape);
    }
  }

  /**
   * Add fullscreen button to native video controls
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
        bottom: 50px;
        right: 10px;
        background: rgba(0, 0, 0, 0.7);
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
        fsButton.style.background = 'rgba(0, 0, 0, 0.9)';
      });

      fsButton.addEventListener('mouseleave', () => {
        fsButton.style.background = 'rgba(0, 0, 0, 0.7)';
      });

      fsButton.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleFullscreen(video);
      });

      // Also allow double-click on video to toggle fullscreen
      video.addEventListener('dblclick', () => {
        this.toggleFullscreen(video);
      });

      // Position video relatively and add button
      const wrapper = video.parentElement;
      if (wrapper) {
        wrapper.style.position = 'relative';
        wrapper.appendChild(fsButton);

        // Store button reference for cleanup
        (video as any)._fsButton = fsButton;
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
