/**
 * MediaUploadAdapterXHR - XMLHttpRequest-based upload for Mac/Linux
 *
 * Uses native browser XHR which works fine on Mac (WebKit) and Linux.
 * Windows WebView2 has CORS issues with XHR to external domains.
 */

import type {
  MediaUploadAdapter,
  UploadOptions,
  UploadResponse,
} from './MediaUploadAdapter';

export class MediaUploadAdapterXHR implements MediaUploadAdapter {
  private xhr: XMLHttpRequest | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  public upload(options: UploadOptions): Promise<UploadResponse> {
    return new Promise((resolve, reject) => {
      const { url, method, headers, body, onProgress } = options;

      this.xhr = new XMLHttpRequest();

      // 60 second timeout
      this.timeoutId = setTimeout(() => {
        this.abort();
        reject(new Error('Upload timeout - please try again'));
      }, 60000);

      // Track upload progress
      this.xhr.upload.onprogress = event => {
        if (event.lengthComputable && onProgress) {
          const percent = Math.round((event.loaded / event.total) * 100);
          onProgress(percent);
        }
      };

      this.xhr.onload = () => {
        this.clearTimeout();
        const responseText = this.xhr!.responseText;

        resolve({
          ok: this.xhr!.status >= 200 && this.xhr!.status < 300,
          status: this.xhr!.status,
          statusText: this.xhr!.statusText,
          text: async () => responseText,
          json: async () => JSON.parse(responseText) as Record<string, unknown>,
        });

        this.xhr = null;
      };

      this.xhr.onerror = () => {
        this.clearTimeout();
        this.xhr = null;
        reject(new Error('Network error'));
      };

      this.xhr.onabort = () => {
        this.clearTimeout();
        this.xhr = null;
        reject(new Error('Upload cancelled'));
      };

      this.xhr.open(method, url);

      // Set headers
      for (const [key, value] of Object.entries(headers)) {
        this.xhr.setRequestHeader(key, value);
      }

      // Use Uint8Array instead of ArrayBuffer (ArrayBuffer is deprecated in XHR.send())
      const bodyToSend =
        body instanceof ArrayBuffer ? new Uint8Array(body) : body;
      this.xhr.send(bodyToSend);
    });
  }

  public abort(): void {
    this.clearTimeout();
    if (this.xhr) {
      this.xhr.abort();
      this.xhr = null;
    }
  }

  private clearTimeout(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }
}
