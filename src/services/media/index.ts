/**
 * Media Upload Adapter Factory
 */

import type { MediaUploadAdapter } from './MediaUploadAdapter';
import { MediaUploadAdapterXHR } from './MediaUploadAdapterXHR';

export type {
  MediaUploadAdapter,
  UploadOptions,
  UploadResponse,
} from './MediaUploadAdapter';

/**
 * Create upload adapter (XHR for all platforms)
 */
export function createMediaUploadAdapter(): MediaUploadAdapter {
  return new MediaUploadAdapterXHR();
}
