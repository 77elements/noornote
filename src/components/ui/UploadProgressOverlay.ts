/**
 * UploadProgressOverlay
 *
 * Singleton bottom-right floating chip that shows the live state of media
 * compression + upload. Driven by TypedEventBus events emitted by
 * MediaUploadService — every upload entry point in the app is covered by a
 * single mounted instance.
 *
 * States:
 *   compressing  → "Compressing video file…  47%"  (live percent, progress bar)
 *   compressed   → "Compressed: 34 MB → 7 MB"     (1.5s pause)
 *   uploading    → "Uploading to media server… 62%"
 *   uploaded     → "Uploaded"                     (auto-dismiss after 2s)
 *
 * For non-video / non-audio uploads the overlay is not shown — the existing
 * per-button progress UI in callers continues to drive that visual.
 *
 * Mounted once at app start (App.ts) so it can render whenever the upload
 * service emits an UploadStatus event.
 */

import { TypedEventBus } from '../../core/TypedEventBus';
import type { UploadStatus } from '../../services/media/compression-types';
import { UPLOAD_STATUS_EVENT } from '../../core/events';

const COMPRESSED_PAUSE_MS = 1500;
const DISMISS_AFTER_UPLOADED_MS = 2000;

export class UploadProgressOverlay {
  private static instance: UploadProgressOverlay | null = null;
  private root: HTMLElement | null = null;
  private dismissTimer: number | null = null;
  private subscriptionId: string | null = null;

  private constructor() {}

  public static getInstance(): UploadProgressOverlay {
    if (!UploadProgressOverlay.instance) {
      UploadProgressOverlay.instance = new UploadProgressOverlay();
    }
    return UploadProgressOverlay.instance;
  }

  public mount(): void {
    if (this.root) return;
    const el = document.createElement('div');
    el.className = 'upload-progress-overlay upload-progress-overlay--hidden';
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = `
      <div class="upload-progress-overlay__icon" data-icon></div>
      <div class="upload-progress-overlay__body">
        <div class="upload-progress-overlay__line">
          <span class="upload-progress-overlay__message" data-message></span>
          <span class="upload-progress-overlay__percent" data-percent></span>
        </div>
        <div class="upload-progress-overlay__bar" data-bar-wrap>
          <div class="upload-progress-overlay__bar-fill" data-bar-fill></div>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    this.root = el;

    this.subscriptionId = TypedEventBus.getInstance().on(UPLOAD_STATUS_EVENT, (status: UploadStatus) => {
      this.handleStatus(status);
    });
  }

  public unmount(): void {
    if (this.subscriptionId) {
      TypedEventBus.getInstance().off(this.subscriptionId);
      this.subscriptionId = null;
    }
    if (this.dismissTimer !== null) {
      window.clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
    this.root?.remove();
    this.root = null;
  }

  private handleStatus(status: UploadStatus): void {
    if (!this.root) return;
    if (status.mediaKind !== 'video' && status.mediaKind !== 'audio') return;

    if (this.dismissTimer !== null) {
      window.clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }

    const message = this.root.querySelector('[data-message]') as HTMLElement;
    const percentEl = this.root.querySelector('[data-percent]') as HTMLElement;
    const barWrap = this.root.querySelector('[data-bar-wrap]') as HTMLElement;
    const barFill = this.root.querySelector('[data-bar-fill]') as HTMLElement;
    const iconEl = this.root.querySelector('[data-icon]') as HTMLElement;

    this.root.classList.remove('upload-progress-overlay--hidden');
    const batchSuffix = status.totalFiles && status.totalFiles > 1
      ? ` (${(status.fileIndex ?? 0) + 1} of ${status.totalFiles})`
      : '';

    switch (status.phase) {
      case 'compressing': {
        const kindLabel = status.mediaKind === 'video' ? 'video' : 'audio';
        message.textContent = `Compressing ${kindLabel} file…${batchSuffix}`;
        message.classList.add('pulsate');
        percentEl.textContent = `${Math.round(status.percent)}%`;
        barWrap.classList.remove('upload-progress-overlay__bar--hidden');
        barFill.style.width = `${Math.max(0, Math.min(100, status.percent))}%`;
        iconEl.textContent = '📦';
        break;
      }
      case 'compressed': {
        const orig = status.originalBytes ?? 0;
        const comp = status.compressedBytes ?? 0;
        if (comp >= orig) {
          // Compression ran but didn't help — original is uploaded.
          message.textContent = 'Already well-compressed — uploading original';
        } else {
          const reduction = Math.round((1 - comp / orig) * 100);
          message.textContent = `Compressed: ${formatBytes(orig)} → ${formatBytes(comp)} (${reduction}% smaller)`;
        }
        message.classList.remove('pulsate');
        percentEl.textContent = '';
        barWrap.classList.add('upload-progress-overlay__bar--hidden');
        iconEl.textContent = '✓';
        // Hold this state for a moment so the user can read it; the next event
        // (uploading) will arrive shortly and overwrite this.
        this.dismissTimer = window.setTimeout(() => {
          this.dismissTimer = null;
        }, COMPRESSED_PAUSE_MS);
        break;
      }
      case 'uploading': {
        message.textContent = `Uploading to media server…${batchSuffix}`;
        message.classList.add('pulsate');
        percentEl.textContent = `${Math.round(status.percent)}%`;
        barWrap.classList.remove('upload-progress-overlay__bar--hidden');
        barFill.style.width = `${Math.max(0, Math.min(100, status.percent))}%`;
        iconEl.textContent = '⬆';
        break;
      }
      case 'uploaded': {
        message.textContent = 'Uploaded';
        message.classList.remove('pulsate');
        percentEl.textContent = '';
        barWrap.classList.add('upload-progress-overlay__bar--hidden');
        iconEl.textContent = '✓';
        this.dismissTimer = window.setTimeout(() => {
          this.root?.classList.add('upload-progress-overlay--hidden');
          this.dismissTimer = null;
        }, DISMISS_AFTER_UPLOADED_MS);
        break;
      }
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  const value = bytes / Math.pow(k, i);
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}
