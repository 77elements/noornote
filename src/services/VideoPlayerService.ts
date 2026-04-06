/**
 * VideoPlayerService
 * Native HTML5 video player.
 * - Browser (Web): native controls handle everything (no buttons added)
 * - Electron Desktop / Android: adds a download button + auto-pause when scrolled out of view
 */

import { PlatformService } from './PlatformService';
import { ToastService } from './ToastService';
import { downloadMedia } from '../helpers/downloadMedia';

export class VideoPlayerService {
  private static instance: VideoPlayerService | null = null;

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

  // ===== Button Setup =====

  /**
   * Adds a download button to videos and auto-pauses videos that scroll out of view.
   * - Browser (Web): skipped entirely — native controls are sufficient
   */
  public initializeForContainer(container: HTMLElement): void {
    if (this.platform.isBrowser) return;

    const videos = container.querySelectorAll<HTMLVideoElement>('video.note-video');

    videos.forEach(video => {
      if (video.dataset.fsInitialized) return;
      video.dataset.fsInitialized = 'true';

      // Download button
      const dlButton = document.createElement('button');
      dlButton.className = 'btn btn--square';
      dlButton.innerHTML = '<svg width="20" height="20" style="color:white"><use href="#icon-download"/></svg>';
      dlButton.title = 'Download';
      dlButton.style.cssText = 'position:absolute;top:10px;right:10px;background:rgba(0,0,0,0.5);border:none;border-radius:50%;padding:8px;cursor:pointer;z-index:10;display:flex;align-items:center;justify-content:center;';
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
  }

  // ===== Cleanup =====

  public cleanupForContainer(container: HTMLElement): void {
    const videos = container.querySelectorAll<HTMLVideoElement>('video.note-video');
    videos.forEach(video => {
      (video as any)._dlButton?.remove();
      delete (video as any)._dlButton;
      const obs = (video as any)._visibilityObserver as IntersectionObserver | undefined;
      if (obs) { obs.disconnect(); delete (video as any)._visibilityObserver; }
      delete video.dataset.fsInitialized;
    });
  }
}

export function getVideoPlayerService(): VideoPlayerService {
  return VideoPlayerService.getInstance();
}
