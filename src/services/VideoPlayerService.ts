/**
 * VideoPlayerService — Auto-initializes every <video.note-video> as it enters the DOM
 *
 * INVIOLABLE RULE (enforced by /build-validate):
 *   A <video.note-video> ALWAYS plays via native controls, regardless of nesting
 *   depth or render path. Download button + auto-pause are wired up by the global
 *   MutationObserver below — there are NO per-container init calls.
 *
 *   Any other click handler in note/quote/preview renderers MUST early-return
 *   when `target.closest('video, .note-media')` is truthy, otherwise it would
 *   pre-empt native video interaction.
 *
 * Per-platform behavior:
 * - Browser (Web): no-op — native controls suffice, no download button
 * - Electron Desktop / Android: download button overlay + auto-pause on scroll-out
 */

import { PlatformService } from './PlatformService';
import { ToastService } from './ToastService';
import { downloadMedia } from '../helpers/downloadMedia';

export class VideoPlayerService {
  private static instance: VideoPlayerService | null = null;

  private readonly platform: PlatformService;
  private observer: MutationObserver | null = null;
  private initialized = false;

  private constructor() {
    this.platform = PlatformService.getInstance();
  }

  public static getInstance(): VideoPlayerService {
    if (!VideoPlayerService.instance) {
      VideoPlayerService.instance = new VideoPlayerService();
    }
    return VideoPlayerService.instance;
  }

  /**
   * Start the global MutationObserver. Idempotent — call once at app startup.
   * On Web (browser), no-op: native video controls are sufficient.
   */
  public init(): void {
    if (this.initialized) return;
    this.initialized = true;
    if (this.platform.isBrowser) return;

    // Init any videos already in DOM at startup time
    document
      .querySelectorAll<HTMLVideoElement>('video.note-video')
      .forEach(v => this.attach(v));

    this.observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (
            node.tagName === 'VIDEO' &&
            node.classList.contains('note-video')
          ) {
            this.attach(node as HTMLVideoElement);
          } else {
            node
              .querySelectorAll<HTMLVideoElement>('video.note-video')
              .forEach(v => this.attach(v));
          }
        }
      }
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  private attach(video: HTMLVideoElement): void {
    if (video.dataset.fsInitialized) return;
    video.dataset.fsInitialized = 'true';

    const dlButton = document.createElement('button');
    dlButton.className = 'btn btn--square';
    dlButton.innerHTML =
      '<svg width="20" height="20" style="color:white"><use href="#icon-download"/></svg>';
    dlButton.title = 'Download';
    dlButton.style.cssText =
      'position:absolute;top:10px;right:10px;background:rgba(0,0,0,0.5);border:none;border-radius:50%;padding:8px;cursor:pointer;z-index:10;display:flex;align-items:center;justify-content:center;';
    dlButton.addEventListener('click', async e => {
      e.stopPropagation();
      const src = video.currentSrc || video.src;
      if (!src) return;
      const fileName = src.split('/').pop()?.split('?')[0] || 'video.mp4';
      try {
        await downloadMedia(src, fileName);
      } catch {
        ToastService.show('Failed to save video', 'error');
      }
    });

    const wrapper = video.parentElement;
    if (wrapper) {
      wrapper.style.position = 'relative';
      wrapper.appendChild(dlButton);
    }

    const visibilityObserver = new IntersectionObserver(
      entries => {
        entries.forEach(e => {
          if (!e.isIntersecting && !video.paused) video.pause();
        });
      },
      { threshold: 0 }
    );
    visibilityObserver.observe(video);
  }
}

export function getVideoPlayerService(): VideoPlayerService {
  return VideoPlayerService.getInstance();
}
