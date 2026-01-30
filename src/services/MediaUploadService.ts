/**
 * MediaUploadService
 *
 * Features:
 * - Blossom (BUD-02) and NIP-96 support
 * - Multiple file uploads (sequential)
 * - Proper cancellation with AbortController
 * - Clean error handling
 * - Progress tracking
 * - Platform-specific upload adapters (Windows uses Tauri HTTP, Mac/Linux uses XHR)
 */

import { AuthService } from './AuthService';
import { ErrorService } from './ErrorService';
import { PlatformService } from './PlatformService';
import { ToastService } from './ToastService';
import { createMediaUploadAdapter, type MediaUploadAdapter } from './media';

interface MediaServerSettings {
  url: string;
  protocol: 'blossom' | 'nip96';
}

interface UploadResult {
  success: boolean;
  url?: string;
  error?: string;
}

type ProgressCallback = (progress: number) => void;

export class MediaUploadService {
  private static instance: MediaUploadService;
  private authService: AuthService;
  private platform: PlatformService;
  private mediaServerStorageKey = 'noornote_media_server';
  private uploadAdapter: MediaUploadAdapter;

  private readonly MAX_FILE_SIZE_FREE = 10 * 1024 * 1024;
  private readonly MAX_FILE_SIZE_BLOSSOM = 50 * 1024 * 1024;
  private readonly SIGN_TIMEOUT_MS = 30000;

  private constructor() {
    this.authService = AuthService.getInstance();
    this.platform = PlatformService.getInstance();
    this.uploadAdapter = createMediaUploadAdapter();
  }

  public static getInstance(): MediaUploadService {
    if (!MediaUploadService.instance) {
      MediaUploadService.instance = new MediaUploadService();
    }
    return MediaUploadService.instance;
  }

  private errorResult(error: string): UploadResult {
    return { success: false, error };
  }

  private mapUploadProgress(adapterPercent: number): number {
    return 20 + Math.round(adapterPercent * 0.7);
  }

  /**
   * Convert server URL to proxy URL for browser mode
   * Dev: routes through Vite's dev server proxy
   * Production: routes through Deno Deploy proxy
   */
  private getProxiedUrl(serverUrl: string, path: string): string {
    if (!this.platform.isBrowser) {
      return `${serverUrl}${path}`;
    }

    if (import.meta.env.DEV) {
      // Dev mode: Vite proxy with known server map
      const proxyMap: Record<string, string> = {
        'https://blossom.nostr.build': '/proxy/blossom.nostr.build',
        'https://nostr.build': '/proxy/nostr.build',
        'https://blossom.band': '/proxy/blossom.band',
        'https://blossom.primal.net': '/proxy/blossom.primal.net',
      };

      const proxyPath = proxyMap[serverUrl];
      if (proxyPath) return `${proxyPath}${path}`;

      return `${serverUrl}${path}`;
    }

    // Production: Deno Deploy proxy (works with any server)
    const hostname = new URL(serverUrl).hostname;
    return `https://noornote-proxy.77elements.deno.net/proxy/${hostname}${path}`;
  }

  private loadMediaServerSettings(): MediaServerSettings {
    try {
      const stored = localStorage.getItem(this.mediaServerStorageKey);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (error) {
      console.warn('Failed to load media server settings:', error);
    }

    return { url: 'https://nostr.build', protocol: 'nip96' };
  }

  private validateFile(file: File, protocol: 'blossom' | 'nip96'): { valid: boolean; error?: string } {
    const maxSize = protocol === 'blossom' ? this.MAX_FILE_SIZE_BLOSSOM : this.MAX_FILE_SIZE_FREE;

    if (file.size > maxSize) {
      const maxSizeMB = Math.floor(maxSize / 1024 / 1024);
      return { valid: false, error: `File too large. Maximum size: ${maxSizeMB} MB` };
    }

    if (!/^(image|video|audio)\//.test(file.type)) {
      return { valid: false, error: 'Unsupported file type. Only images, videos, and audio are allowed.' };
    }

    return { valid: true };
  }

  private async calculateSHA256(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private async signEventWithTimeout(event: any): Promise<any> {
    return Promise.race([
      this.authService.signEvent(event),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Signing timeout - please check your browser extension')), this.SIGN_TIMEOUT_MS)
      )
    ]);
  }

  private async createBlossomAuth(sha256: string): Promise<string> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('Not authenticated');

    const now = Math.floor(Date.now() / 1000);

    const signedEvent = await this.signEventWithTimeout({
      kind: 24242,
      created_at: now,
      tags: [
        ['t', 'upload'],
        ['x', sha256],
        ['expiration', (now + 300).toString()]
      ],
      content: 'Upload file',
      pubkey: currentUser.pubkey
    });

    return `Nostr ${btoa(JSON.stringify(signedEvent))}`;
  }

  private async createNIP98Auth(method: string, url: string, sha256: string): Promise<string> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('Not authenticated');

    const signedEvent = await this.signEventWithTimeout({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['u', url],
        ['method', method],
        ['payload', sha256]
      ],
      content: '',
      pubkey: currentUser.pubkey
    });

    return `Nostr ${btoa(JSON.stringify(signedEvent))}`;
  }

  private async uploadBlossom(
    file: File,
    serverUrl: string,
    onProgress?: ProgressCallback
  ): Promise<UploadResult> {
    try {
      onProgress?.(5);
      const sha256 = await this.calculateSHA256(file);

      onProgress?.(15);
      const authHeader = await this.createBlossomAuth(sha256);

      onProgress?.(20);

      // Browser mode: Use fetch with proper CORS handling
      if (this.platform.isBrowser) {
        return await this.uploadBlossomBrowser(file, serverUrl, authHeader, onProgress);
      }

      // Tauri mode: Use adapter (CORS bypassed)
      const response = await this.uploadAdapter.upload({
        url: `${serverUrl}/upload`,
        method: 'PUT',
        headers: {
          'Authorization': authHeader,
          'Content-Type': file.type || 'application/octet-stream'
        },
        body: file,
        onProgress: (percent) => onProgress?.(this.mapUploadProgress(percent))
      });

      if (response.ok) {
        const descriptor = await response.json();
        onProgress?.(100);
        return { success: true, url: descriptor.url };
      }

      return this.errorResult(`Upload failed: ${response.status} ${response.statusText}`);
    } catch (error) {
      console.error('Blossom upload error:', error);
      return this.errorResult(`Upload error: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Browser-specific Blossom upload using fetch
   * Uses Vite proxy in dev mode to bypass CORS
   */
  private async uploadBlossomBrowser(
    file: File,
    serverUrl: string,
    authHeader: string,
    onProgress?: ProgressCallback
  ): Promise<UploadResult> {
    try {
      // Note: fetch doesn't support upload progress, so we use pseudo-progress
      onProgress?.(30);

      const uploadUrl = this.getProxiedUrl(serverUrl, '/upload');

      const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Authorization': authHeader
        },
        body: file
      });

      onProgress?.(90);

      if (response.ok) {
        const descriptor = await response.json();
        onProgress?.(100);
        return { success: true, url: descriptor.url };
      }

      const errorText = await response.text();
      return this.errorResult(`Upload failed: ${response.status} ${errorText || response.statusText}`);
    } catch (error) {
      console.error('Blossom browser upload error:', error);
      return this.errorResult(`Upload error: ${error instanceof Error ? error.message : 'Network error - server may not support CORS'}`);
    }
  }

  private async fetchNIP96ConfigFromUrl(url: string): Promise<{ api_url: string } | null> {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      console.warn('Failed to fetch NIP-96 config:', error);
      return null;
    }
  }

  /**
   * Convert an API URL to a proxied URL for browser dev mode
   * Handles both absolute URLs and relative paths
   */
  private getProxiedApiUrl(serverUrl: string, apiUrl: string): string {
    if (!this.platform.isBrowser || !import.meta.env.DEV) {
      return apiUrl;
    }

    // If apiUrl is relative, combine with serverUrl
    if (apiUrl.startsWith('/')) {
      return this.getProxiedUrl(serverUrl, apiUrl);
    }

    // If apiUrl is absolute, try to extract server and path
    try {
      const url = new URL(apiUrl);
      const serverBase = `${url.protocol}//${url.host}`;
      return this.getProxiedUrl(serverBase, url.pathname + url.search);
    } catch {
      // If URL parsing fails, return as-is
      return apiUrl;
    }
  }

  private async buildMultipartBody(file: File, fields: Record<string, string>): Promise<{ body: ArrayBuffer; boundary: string }> {
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];

    for (const [key, value] of Object.entries(fields)) {
      parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
    }

    parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`));
    parts.push(new Uint8Array(await file.arrayBuffer()));
    parts.push(encoder.encode('\r\n'));
    parts.push(encoder.encode(`--${boundary}--\r\n`));

    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const body = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      body.set(part, offset);
      offset += part.length;
    }

    return { body: body.buffer, boundary };
  }

  private async uploadNIP96(
    file: File,
    serverUrl: string,
    onProgress?: ProgressCallback
  ): Promise<UploadResult> {
    try {
      onProgress?.(5);

      // In browser mode, fetch config through proxy to bypass CORS
      const configUrl = this.platform.isBrowser
        ? this.getProxiedUrl(serverUrl, '/.well-known/nostr/nip96.json')
        : `${serverUrl}/.well-known/nostr/nip96.json`;

      const config = await this.fetchNIP96ConfigFromUrl(configUrl);
      const apiUrl = config?.api_url || `${serverUrl}/upload`;

      onProgress?.(10);
      const sha256 = await this.calculateSHA256(file);

      onProgress?.(15);
      // Sign with the original apiUrl (what the server expects)
      const authHeader = await this.createNIP98Auth('POST', apiUrl, sha256);

      onProgress?.(20);

      // Browser mode: Use native FormData with XMLHttpRequest
      // In dev mode, route through proxy to bypass CORS
      if (this.platform.isBrowser) {
        // Convert apiUrl to proxied URL for the actual request
        const proxiedApiUrl = this.getProxiedApiUrl(serverUrl, apiUrl);
        return await this.uploadNIP96Browser(file, proxiedApiUrl, authHeader, onProgress);
      }

      // Tauri mode: manual multipart (existing behavior)
      const { body, boundary } = await this.buildMultipartBody(file, {
        content_type: file.type,
        size: file.size.toString()
      });

      const response = await this.uploadAdapter.upload({
        url: apiUrl,
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body: body,
        onProgress: (percent) => onProgress?.(this.mapUploadProgress(percent))
      });

      if (response.ok) {
        const result = await response.json();
        if (result.status === 'success' && result.nip94_event) {
          const urlTag = result.nip94_event.tags.find((t: string[]) => t[0] === 'url');
          if (urlTag) {
            onProgress?.(100);
            return { success: true, url: urlTag[1] };
          }
        }
        return this.errorResult('No URL in upload response');
      }

      return this.errorResult(`Upload failed: ${response.status} ${response.statusText}`);
    } catch (error) {
      console.error('NIP-96 upload error:', error);
      return this.errorResult(`Upload error: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Browser-specific NIP-96 upload using native FormData
   * Browser sets Content-Type with boundary automatically, avoiding CORS preflight issues
   */
  private async uploadNIP96Browser(
    file: File,
    apiUrl: string,
    authHeader: string,
    onProgress?: ProgressCallback
  ): Promise<UploadResult> {
    return new Promise((resolve) => {
      const formData = new FormData();
      formData.append('file', file);

      const xhr = new XMLHttpRequest();

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          onProgress?.(this.mapUploadProgress(percent));
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const result = JSON.parse(xhr.responseText);
            if (result.status === 'success' && result.nip94_event) {
              const urlTag = result.nip94_event.tags.find((t: string[]) => t[0] === 'url');
              if (urlTag) {
                onProgress?.(100);
                resolve({ success: true, url: urlTag[1] });
                return;
              }
            }
            resolve(this.errorResult('No URL in upload response'));
          } catch (e) {
            resolve(this.errorResult('Failed to parse upload response'));
          }
        } else {
          resolve(this.errorResult(`Upload failed: ${xhr.status} ${xhr.statusText}`));
        }
      };

      xhr.onerror = () => {
        resolve(this.errorResult('Network error - server may not support CORS'));
      };

      xhr.open('POST', apiUrl);
      xhr.setRequestHeader('Authorization', authHeader);
      // DO NOT set Content-Type - browser sets it automatically with correct boundary
      xhr.send(formData);
    });
  }

  public async uploadFile(file: File, onProgress?: ProgressCallback): Promise<UploadResult> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        const errorMsg = 'Please log in to upload files';
        ToastService.show(errorMsg, 'error');
        return this.errorResult(errorMsg);
      }

      const settings = this.loadMediaServerSettings();

      const validation = this.validateFile(file, settings.protocol);
      if (!validation.valid) {
        ToastService.show(validation.error || 'Invalid file', 'error');
        return this.errorResult(validation.error || 'Invalid file');
      }

      const result = settings.protocol === 'blossom'
        ? await this.uploadBlossom(file, settings.url, onProgress)
        : await this.uploadNIP96(file, settings.url, onProgress);

      ToastService.show(
        result.success ? 'File uploaded successfully!' : (result.error || 'Upload failed'),
        result.success ? 'success' : 'error'
      );

      return result;
    } catch (error) {
      ErrorService.handle(error, 'MediaUploadService.uploadFile', true, 'Failed to upload file');
      return this.errorResult(error instanceof Error ? error.message : 'Upload failed');
    }
  }

  public async uploadFiles(
    files: File[],
    onProgress?: (fileIndex: number, progress: number, totalFiles: number) => void
  ): Promise<UploadResult[]> {
    const results: UploadResult[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;
      const result = await this.uploadFile(file, (progress) => {
        onProgress?.(i, progress, files.length);
      });
      results.push(result);

      if (!result.success) break;
    }

    return results;
  }

  public cancelUpload(): void {
    this.uploadAdapter.abort();
  }
}
