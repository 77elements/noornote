/**
 * Shared "pick an image, upload via the media module, put the URL into an
 * input" flow used by addon settings forms (badge creator, custom emoji
 * pack creation): identical busy-status, error toasts and success fill.
 */

import { _ } from '../i18n';
import { ToastService } from '../services/ToastService';

/**
 * Upload `file` through the media module and, on success, write the URL
 * into the input matching `urlInputSelector` inside `scope`. Shows the
 * pulsating "Uploading…" status on `statusSelector` while running and a
 * success toast with `successMessage` afterwards.
 */
export async function uploadImageToUrlField(opts: {
  scope: ParentNode;
  file: File;
  urlInputSelector: string;
  statusSelector?: string;
  successMessage: string;
}): Promise<void> {
  const status = opts.statusSelector
    ? (opts.scope.querySelector(opts.statusSelector) as HTMLElement | null)
    : null;
  if (status) {
    status.textContent = _('Uploading…');
    status.classList.add('pulsate');
  }

  try {
    const { ModuleLoader } = await import('../core/ModuleLoader');
    type MediaApi = import('../modules/media/contracts').MediaModuleApi;
    const mediaApi = await ModuleLoader.getInstance().ensure<MediaApi>('media');
    if (!mediaApi) {
      ToastService.show(_('Media module not available'), 'error');
      return;
    }
    const result = await mediaApi.uploadFile(opts.file);
    if (result.success && result.url) {
      const urlInput = opts.scope.querySelector(
        opts.urlInputSelector
      ) as HTMLInputElement | null;
      if (urlInput) urlInput.value = result.url;
      ToastService.show(opts.successMessage, 'success');
    } else {
      ToastService.show(result.error || _('Upload failed'), 'error');
    }
  } catch (err) {
    ToastService.show((err as Error).message || _('Upload failed'), 'error');
  } finally {
    if (status) {
      status.textContent = '';
      status.classList.remove('pulsate');
    }
  }
}
