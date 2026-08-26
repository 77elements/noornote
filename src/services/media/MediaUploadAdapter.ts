/**
 * MediaUploadAdapter - Interface for platform-specific upload implementations
 *
 * Mac/Linux: Uses XMLHttpRequest (works fine)
 * Windows: Uses Electron HTTP (bypasses WebView CORS issues)
 */

export interface UploadOptions {
  url: string;
  method: 'PUT' | 'POST';
  headers: Record<string, string>;
  body: ArrayBuffer | Blob;
  onProgress?: (progress: number) => void;
}

export interface UploadResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<Record<string, unknown>>;
}

export interface MediaUploadAdapter {
  /**
   * Upload data to a URL
   */
  upload(options: UploadOptions): Promise<UploadResponse>;

  /**
   * Abort the current upload
   */
  abort(): void;
}
