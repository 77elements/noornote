/**
 * VideoPlayerService
 * Native HTML5 video player with fullscreen support
 * - Browser (Web): No custom fullscreen — native controls work
 * - Electron Desktop: Overlay with cloned video (document.fullscreenEnabled is false)
 * - Android: No fullscreen support (WebView limitation, no fix available)
 */

import { PlatformService } from './PlatformService';
import { ToastService } from './ToastService';
import { downloadMedia } from '../helpers/downloadMedia';

export class VideoPlayerService {
  private static instance: VideoPlayerService | null = null;
  private originalVideo: HTMLVideoElement | null = null;
  private fullscreenOverlay: HTMLElement | null = null;
  private fullscreenVideo: HTMLVideoElement | null = null;
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;

  private readonly platform: PlatformService;

  private constructor() {
    this.platform = PlatformService.getInstance();
  }

  public static getInstance(): VideoPlayerService {
    if (!VideoPlayerService.instance) {
      VideoPlayerService.instance = new VideoPlayerService();
    }
    return VideoPlayerService.instance;
  }

  // ===== Fullscreen Toggle =====

  private toggleFullscreen(video: HTMLVideoElement): void {
    if (this.fullscreenOverlay) {
      this.exitFullscreen();
      return;
    }
    this.enterOverlayFullscreen(video);
  }

  // ===== Overlay Fullscreen (Electron Desktop) =====

  private enterOverlayFullscreen(video: HTMLVideoElement): void {
    const src = video.currentSrc || video.src;
    if (!src) return;

    const savedTime = video.currentTime;
    const wasPlaying = !video.paused;
    video.pause();
    this.originalVideo = video;

    // Overlay
    const overlay = document.createElement('div');
    overlay.className = 'video-fs-overlay';

    // Fresh video element (no reparenting — reparenting breaks Android WebView)
    const fsVideo = document.createElement('video');
    fsVideo.src = src;
    fsVideo.className = 'video-fs-overlay__video';
    fsVideo.controls = true;
    fsVideo.playsInline = true;
    fsVideo.preload = 'auto';

    // Close button (X)
    const closeBtn = document.createElement('button');
    closeBtn.className = 'video-fs-overlay__close';
    closeBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener('click', () => this.exitFullscreen());

    // Download button
    const dlBtn = document.createElement('button');
    dlBtn.className = 'video-fs-overlay__dl';
    dlBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
    dlBtn.addEventListener('click', async () => {
      const fileName = src.split('/').pop()?.split('?')[0] || 'video.mp4';
      try { await downloadMedia(src, fileName); }
      catch { ToastService.show('Failed to save video', 'error'); }
    });

    overlay.appendChild(fsVideo);
    overlay.appendChild(closeBtn);
    overlay.appendChild(dlBtn);
    document.body.appendChild(overlay);

    this.fullscreenOverlay = overlay;
    this.fullscreenVideo = fsVideo;
    document.body.classList.add('video-fs-active');

    // Seek to saved position and play when video is ready
    const seekAndPlay = () => {
      fsVideo.currentTime = savedTime;
      if (wasPlaying) {
        fsVideo.addEventListener('seeked', () => {
          fsVideo.play().catch(() => {});
        }, { once: true });
      }
    };

    // canplay = enough data to play at current position (more reliable than loadedmetadata for seek)
    if (fsVideo.readyState >= 3) {
      seekAndPlay();
    } else {
      fsVideo.addEventListener('canplay', seekAndPlay, { once: true });
    }

    // Escape to exit
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.exitFullscreen();
    };
    document.addEventListener('keydown', this.escapeHandler);

    // Tap overlay background to exit
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.exitFullscreen();
    });
  }

  private exitFullscreen(): void {
    if (!this.fullscreenOverlay || !this.fullscreenVideo) return;

    const currentTime = this.fullscreenVideo.currentTime;
    const wasPlaying = !this.fullscreenVideo.paused;
    this.fullscreenVideo.pause();

    if (this.originalVideo) {
      this.originalVideo.currentTime = currentTime;
      if (wasPlaying) this.originalVideo.play().catch(() => {});
    }

    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler);
      this.escapeHandler = null;
    }

    this.fullscreenOverlay.remove();
    this.fullscreenOverlay = null;
    this.fullscreenVideo = null;
    this.originalVideo = null;
    document.body.classList.remove('video-fs-active');
  }

  // ===== Button Setup =====

  /**
   * Adds fullscreen + download buttons to videos.
   * - Browser (Web): skipped entirely — native controls have fullscreen
   * - Android: only download button (fullscreen not possible in WebView)
   * - Electron Desktop: fullscreen + download buttons
   */
  public initializeForContainer(container: HTMLElement): void {
    // Web browser: native fullscreen works, no custom buttons needed
    if (this.platform.isBrowser) return;

    const isAndroid = this.platform.isAndroid;
    const videos = container.querySelectorAll<HTMLVideoElement>('video.note-video');

    videos.forEach(video => {
      if (video.dataset.fsInitialized) return;
      video.dataset.fsInitialized = 'true';

      // Fullscreen button — Desktop only
      if (!isAndroid) {
        const fsButton = document.createElement('button');
        fsButton.className = 'video-fullscreen-btn';
        fsButton.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
        fsButton.title = 'Fullscreen';
        fsButton.style.cssText = 'position:absolute;top:10px;right:10px;background:rgba(0,0,0,0.5);border:none;border-radius:4px;padding:8px;cursor:pointer;z-index:10;display:flex;align-items:center;justify-content:center;';
        fsButton.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleFullscreen(video);
        });

        // Double-click to fullscreen (Desktop only)
        video.addEventListener('dblclick', () => this.toggleFullscreen(video));

        const wrapper = video.parentElement;
        if (wrapper) {
          wrapper.style.position = 'relative';
          wrapper.appendChild(fsButton);
          (video as any)._fsButton = fsButton;
        }
      }

      // Download button — both Desktop and Android
      const dlButton = document.createElement('button');
      dlButton.className = 'video-download-btn';
      dlButton.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
      dlButton.title = 'Download';
      const dlRight = isAndroid ? '10px' : '50px';
      dlButton.style.cssText = `position:absolute;top:10px;right:${dlRight};background:rgba(0,0,0,0.5);border:none;border-radius:4px;padding:8px;cursor:pointer;z-index:10;display:flex;align-items:center;justify-content:center;`;
      dlButton.addEventListener('click', async (e) => {
        e.stopPropagation();
        const src = video.currentSrc || video.src;
        if (!src) return;
        const fileName = src.split('/').pop()?.split('?')[0] || 'video.mp4';
        try { await downloadMedia(src, fileName); }
        catch { ToastService.show('Failed to save video', 'error'); }
      });

      const wrapper = video.parentElement;
      if (wrapper) {
        wrapper.style.position = 'relative';
        wrapper.appendChild(dlButton);
        (video as any)._dlButton = dlButton;
      }

      // Auto-pause when scrolled away
      const observer = new IntersectionObserver(
        (entries) => { entries.forEach(e => { if (!e.isIntersecting && !video.paused) video.pause(); }); },
        { threshold: 0 }
      );
      observer.observe(video);
      (video as any)._visibilityObserver = observer;
    });

    // Inject overlay CSS once (Desktop only)
    if (!isAndroid && !document.getElementById('video-fs-css')) {
      const style = document.createElement('style');
      style.id = 'video-fs-css';
      style.textContent = `
        .video-fs-overlay {
          position: fixed;
          top: 0; left: 0;
          width: 100vw; height: 100vh;
          z-index: 9999;
          background: #000;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .video-fs-overlay__video {
          width: 100%; height: 100%;
          object-fit: contain;
        }
        .video-fs-overlay__close {
          position: absolute;
          top: 12px; right: 12px;
          z-index: 10000;
          background: rgba(0,0,0,0.6);
          border: none;
          border-radius: 50%;
          width: 40px; height: 40px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
        }
        .video-fs-overlay__dl {
          position: absolute;
          top: 12px; right: 64px;
          z-index: 10000;
          background: rgba(0,0,0,0.6);
          border: none;
          border-radius: 4px;
          padding: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
        }
        .video-fs-active {
          overflow: hidden !important;
        }
      `;
      document.head.appendChild(style);
    }
  }

  // ===== Cleanup =====

  public cleanupForContainer(container: HTMLElement): void {
    const videos = container.querySelectorAll<HTMLVideoElement>('video.note-video');
    videos.forEach(video => {
      (video as any)._fsButton?.remove();
      (video as any)._dlButton?.remove();
      delete (video as any)._fsButton;
      delete (video as any)._dlButton;
      const obs = (video as any)._visibilityObserver as IntersectionObserver | undefined;
      if (obs) { obs.disconnect(); delete (video as any)._visibilityObserver; }
      delete video.dataset.fsInitialized;
    });

    if (this.fullscreenOverlay) this.exitFullscreen();
  }
}

export function getVideoPlayerService(): VideoPlayerService {
  return VideoPlayerService.getInstance();
}
