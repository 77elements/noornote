/**
 * Single-media upload helper for the NosPress editor.
 *
 * Three block kinds (image/video/audio) had near-identical upload flows
 * (~60 LOC each, 3× duplicated): mime-prefix check, progress-ring SVG
 * inlined into the trigger button, MediaUploadService.uploadFile call,
 * mutate-draft on success, restore button on finally. This module owns
 * the shared parts so the editor only carries kind-specific glue.
 *
 * The progress SVG is inlined (not an `icons.svg` `<use>`) because <use>
 * clones into shadow DOM and JS can't reach in to drive
 * `strokeDashoffset` for the radial fill animation. Same trade-off as
 * `PostEditorToolbar` / `ImageUploader`.
 *
 * Gallery upload (`handleGalleryUpload`) deliberately stays in
 * NospressView — it operates on multiple files with text-based progress
 * ("Uploading 2/5…"), not the radial ring; mixing the two patterns
 * would cost more than it saves.
 */

import { MediaUploadService } from '../../../services/MediaUploadService';
import { ToastService } from '../../../services/ToastService';

export type SingleMediaKind = 'image' | 'video' | 'audio';

interface KindCfg {
  mimePrefix: string;
  actionAttr: string;
  errorLabel: string;
}

const KIND_CFG: Record<SingleMediaKind, KindCfg> = {
  image: { mimePrefix: 'image/', actionAttr: 'upload-image', errorLabel: 'Image upload failed' },
  video: { mimePrefix: 'video/', actionAttr: 'upload-video', errorLabel: 'Video upload failed' },
  audio: { mimePrefix: 'audio/', actionAttr: 'upload-audio', errorLabel: 'Audio upload failed' },
};

const PROGRESS_SVG = `
  <svg width="20" height="20" class="upload-progress" viewBox="0 0 24 24">
    <circle class="upload-progress-bg" cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" opacity="0.2"/>
    <circle class="upload-progress-bar" cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="62.83" stroke-dashoffset="62.83"/>
  </svg>
`;
const PROGRESS_CIRCUMFERENCE = 62.83; // 2 * PI * r=10

/**
 * Click the hidden file input for the given block kind. The renderer
 * mounted it as `<input data-block-id="…" data-{kind}-file>`.
 */
export function triggerSingleMediaUpload(container: HTMLElement, blockId: string, kind: SingleMediaKind): void {
  const sel = `[data-block-id="${blockId}"][data-${kind}-file]`;
  const fileInput = container.querySelector(sel) as HTMLInputElement | null;
  fileInput?.click();
}

/**
 * Upload a single image/video/audio file for the given block. Drives the
 * radial progress ring inside the trigger button, calls back with the
 * resolved URL once done. Toast on validation/upload failure.
 *
 * The `applyUrl` callback receives the uploaded URL — the caller is
 * responsible for writing it into the draft (so we don't import
 * mutateDraft / block-finder logic in here).
 */
export async function handleSingleMediaUpload(
  container: HTMLElement,
  blockId: string,
  file: File,
  kind: SingleMediaKind,
  applyUrl: (url: string) => void,
): Promise<void> {
  const cfg = KIND_CFG[kind];

  if (!file.type.startsWith(cfg.mimePrefix)) {
    ToastService.show(`Please select a ${kind} file`, 'error');
    return;
  }

  const uploadBtn = container.querySelector(
    `[data-block-id="${blockId}"][data-action="${cfg.actionAttr}"]`
  ) as HTMLButtonElement | null;
  if (!uploadBtn) return;

  const originalHTML = uploadBtn.innerHTML;
  uploadBtn.disabled = true;
  uploadBtn.innerHTML = PROGRESS_SVG;

  const updateProgress = (progress: number) => {
    const bar = uploadBtn.querySelector('.upload-progress-bar') as SVGCircleElement | null;
    if (!bar) return;
    const offset = PROGRESS_CIRCUMFERENCE - (progress / 100) * PROGRESS_CIRCUMFERENCE;
    bar.style.strokeDashoffset = String(offset);
  };

  try {
    const result = await MediaUploadService.getInstance().uploadFile(file, updateProgress);
    if (result.success && result.url) {
      applyUrl(result.url);
    }
  } catch (error) {
    console.error(`${kind} upload failed:`, error);
    ToastService.show(cfg.errorLabel, 'error');
  } finally {
    if (uploadBtn.isConnected) {
      uploadBtn.disabled = false;
      uploadBtn.innerHTML = originalHTML;
    }
  }
}
