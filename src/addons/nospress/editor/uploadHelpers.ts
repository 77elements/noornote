/**
 * Media upload helpers for the NosPress editor.
 *
 *   - `triggerSingleMediaUpload` / `handleSingleMediaUpload`
 *       Image / Video / Audio blocks — single file, radial progress.
 *   - `handleMultiMediaUpload`
 *       Gallery + Portfolio blocks — multiple files, same radial
 *       progress driven from an overall-progress percentage.
 *
 * The progress ring uses the shared `#icon-upload-progress` sprite
 * symbol — identical to `PostEditorToolbar` (the "New Note" editor's
 * upload button). The cloned `<circle class="upload-progress-bar">`
 * is reachable via querySelector on the live SVG tree, so JS can drive
 * `strokeDashoffset` for the radial fill animation.
 */

import { MediaUploadService } from '../../../services/MediaUploadService';
import { ToastService } from '../../../services/ToastService';

export type SingleMediaKind = 'image' | 'video' | 'audio' | 'card-image';

interface KindCfg {
  mimePrefix: string;
  actionAttr: string;
  errorLabel: string;
  /** Override the `[data-${kind}-file]` selector when the file-input
   *  attribute uses a different key than the kind itself. Lets `card-image`
   *  reuse the image MIME validation + upload pipeline while keeping its
   *  own DOM hooks separate from the standalone Image block. */
  fileAttr?: string;
}

const KIND_CFG: Record<SingleMediaKind, KindCfg> = {
  image:        { mimePrefix: 'image/', actionAttr: 'upload-image',      errorLabel: 'Image upload failed' },
  video:        { mimePrefix: 'video/', actionAttr: 'upload-video',      errorLabel: 'Video upload failed' },
  audio:        { mimePrefix: 'audio/', actionAttr: 'upload-audio',      errorLabel: 'Audio upload failed' },
  'card-image': { mimePrefix: 'image/', actionAttr: 'upload-card-image', errorLabel: 'Card image upload failed', fileAttr: 'card-image-file' },
};

const PROGRESS_SVG = `<svg width="20" height="20" class="upload-progress"><use href="#icon-upload-progress"/></svg>`;
const PROGRESS_CIRCUMFERENCE = 62.83; // 2 * PI * r=10

/**
 * Click the hidden file input for the given block kind. The renderer
 * mounted it as `<input data-block-id="…" data-{kind}-file>`.
 */
export function triggerSingleMediaUpload(container: HTMLElement, blockId: string, kind: SingleMediaKind): void {
  const fileAttr = KIND_CFG[kind].fileAttr ?? `${kind}-file`;
  const sel = `[data-block-id="${blockId}"][data-${fileAttr}]`;
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
    // mimePrefix is `image/` / `video/` / `audio/` — strip the slash for
    // the user-facing label so `card-image` reads as "image", not "card-image".
    const label = cfg.mimePrefix.replace('/', '');
    ToastService.show(`Please select a valid ${label} file`, 'error');
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
    const bar = uploadBtn.querySelector('[data-progress-bar]') as SVGCircleElement | null;
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

/**
 * Upload N image files for a gallery / portfolio-style block. Same
 * radial progress treatment as the single-media path — the trigger
 * button's icon swaps to the spinner SVG and the `upload-progress-bar`
 * circle is driven via overall-progress percentage.
 *
 * @param trigger    The button that initiated the upload. Its
 *                   `innerHTML` is swapped for the spinner and restored
 *                   in `finally`.
 * @param files      Files to upload (caller filters by mime if needed).
 * @param mimePrefix Optional filter — files whose `type` doesn't start
 *                   with this string are rejected with a toast and the
 *                   upload aborts. Pass `'image/'` to gate on images.
 * @param applyUrls  Callback invoked once with the URL array of all
 *                   successfully-uploaded files. Caller writes to the
 *                   draft.
 */
export async function handleMultiMediaUpload(
  trigger: HTMLButtonElement | null,
  files: File[],
  applyUrls: (urls: string[]) => void,
  opts: { mimePrefix?: string; rejectLabel?: string } = {},
): Promise<void> {
  if (!trigger) return;

  const accepted = opts.mimePrefix
    ? files.filter(f => f.type.startsWith(opts.mimePrefix!))
    : files;
  if (accepted.length === 0) {
    ToastService.show(opts.rejectLabel ?? 'No valid files selected', 'error');
    return;
  }

  const originalHTML = trigger.innerHTML;
  trigger.disabled = true;
  trigger.innerHTML = PROGRESS_SVG;

  const updateProgress = (overall: number) => {
    const bar = trigger.querySelector('[data-progress-bar]') as SVGCircleElement | null;
    if (!bar) return;
    const offset = PROGRESS_CIRCUMFERENCE - (overall / 100) * PROGRESS_CIRCUMFERENCE;
    bar.style.strokeDashoffset = String(offset);
  };

  try {
    const results = await MediaUploadService.getInstance().uploadFiles(
      accepted,
      (fileIndex, progress, totalFiles) => {
        // Overall = portion of completed files + portion of current file.
        const overall = (fileIndex / totalFiles) * 100 + (progress / totalFiles);
        updateProgress(Math.min(overall, 99));
      },
    );
    const urls = results.filter(r => r.success && r.url).map(r => r.url as string);
    if (urls.length > 0) applyUrls(urls);
    if (urls.length < accepted.length) {
      const failed = accepted.length - urls.length;
      ToastService.show(`${failed} file(s) failed to upload`, 'error');
    }
  } catch (error) {
    console.error('Multi-media upload failed:', error);
    ToastService.show('Upload failed', 'error');
  } finally {
    if (trigger.isConnected) {
      trigger.disabled = false;
      trigger.innerHTML = originalHTML;
    }
  }
}
