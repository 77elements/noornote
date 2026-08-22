/**
 * MediaUploadService
 *
 * Features:
 * - Blossom (BUD-02) and NIP-96 support
 * - Multiple file uploads (sequential)
 * - Proper cancellation with AbortController
 * - Clean error handling
 * - Progress tracking
 * - Platform-specific upload adapters (Windows uses Electron HTTP, Mac/Linux uses XHR)
 */

import { AuthService } from './AuthService';
import { ErrorService } from './ErrorService';
import { PlatformService } from './PlatformService';
import { ToastService } from './ToastService';
import { createMediaUploadAdapter, type MediaUploadAdapter } from './media';
import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { TypedEventBus } from '../core/TypedEventBus';
import { diagLog } from './DiagnosticLogger';
import {
  DEFAULT_MEDIA_COMPRESSION_SETTINGS,
  detectMediaKind,
  type MediaCompressionSettings,
  type MediaKind,
  type UploadStatus,
} from './media/compression-types';
import { UPLOAD_STATUS_EVENT } from '../core/events';

interface MediaServerSettings {
  url: string;
  protocol: 'blossom' | 'nip96';
  maxFileSize?: number | undefined;
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
  private uploadAdapter: MediaUploadAdapter;

  private readonly DEFAULT_NIP96_MAX_FILE_SIZE = 25 * 1024 * 1024;
  private readonly DEFAULT_BLOSSOM_MAX_FILE_SIZE = 20 * 1024 * 1024;
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

  /**
   * Turn a failed upload HTTP status into a message the user can act on.
   * 413 (Payload Too Large) is the common case: the file exceeds the media
   * server's plan limit. Otherwise surface the server's own response text.
   */
  private describeUploadFailure(
    status: number,
    statusText: string,
    responseText?: string
  ): string {
    if (status === 413) {
      return 'File too large for this media server. Try a smaller file, or choose a media server with a higher limit in Settings.';
    }
    const detail = (responseText || '').trim().slice(0, 200);
    return `Upload failed: ${status} ${detail || statusText}`.trim();
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
    return PerAccountLocalStorage.getInstance().get<MediaServerSettings>(
      StorageKeys.MEDIA_SERVER,
      { url: 'https://nostr.build', protocol: 'nip96' }
    );
  }

  private loadCompressionSettings(): MediaCompressionSettings {
    const stored =
      PerAccountLocalStorage.getInstance().get<MediaCompressionSettings>(
        StorageKeys.MEDIA_COMPRESSION,
        DEFAULT_MEDIA_COMPRESSION_SETTINGS
      );
    return {
      image: { ...DEFAULT_MEDIA_COMPRESSION_SETTINGS.image, ...stored.image },
      video: { ...DEFAULT_MEDIA_COMPRESSION_SETTINGS.video, ...stored.video },
      audio: { ...DEFAULT_MEDIA_COMPRESSION_SETTINGS.audio, ...stored.audio },
    };
  }

  private emitStatus(status: UploadStatus): void {
    console.debug(
      '[MediaUploadService] emit',
      status.phase,
      status.percent,
      status.mediaKind
    );
    TypedEventBus.getInstance().emit(UPLOAD_STATUS_EVENT, status);
  }

  /**
   * Compress a video or audio file before upload, if compression is enabled
   * for that media kind and the file is above the min-size threshold. Returns
   * the file to upload (compressed or original on skip/failure).
   *
   * The original file is uploaded as-is on any failure (compression is a
   * best-effort optimization, never a blocker for the upload itself).
   */
  private async maybeCompressMedia(
    file: File,
    mediaKind: MediaKind,
    onStatus: (s: UploadStatus) => void,
    fileIndex?: number,
    totalFiles?: number
  ): Promise<File> {
    if (mediaKind !== 'video' && mediaKind !== 'audio' && mediaKind !== 'image')
      return file;

    // GIFs must skip the image compressor — it draws frame 1 into a canvas and
    // re-encodes as JPEG, killing the animation. Upload the original instead.
    if (file.type === 'image/gif') {
      diagLog('system', 'Media compression skipped', {
        kind: 'image',
        reason: 'gif-animation-preserved',
        filename: file.name,
      });
      return file;
    }

    const settings = this.loadCompressionSettings();
    const kindSettings =
      mediaKind === 'video'
        ? settings.video
        : mediaKind === 'audio'
          ? settings.audio
          : settings.image;
    if (!kindSettings.enabled) {
      diagLog('system', 'Media compression skipped', {
        kind: mediaKind,
        reason: 'disabled-in-settings',
      });
      return file;
    }
    if (file.size < kindSettings.minSizeBytes) {
      diagLog('system', 'Media compression skipped', {
        kind: mediaKind,
        reason: 'below-min-size',
        size: file.size,
      });
      return file;
    }

    let service: typeof import('./media/MediaCompressionService').MediaCompressionService;
    try {
      const mod = await import('./media/MediaCompressionService');
      service = mod.MediaCompressionService;
    } catch (err) {
      diagLog('system', 'Media compression failed', {
        kind: mediaKind,
        reason: 'chunk-load-failed',
        error: String(err),
      });
      ToastService.show('Compression unavailable, uploading original.', 'info');
      return file;
    }

    const supported =
      mediaKind === 'video'
        ? await service.isVideoSupported()
        : mediaKind === 'audio'
          ? await service.isAudioSupported()
          : await service.isImageSupported();
    if (!supported) {
      diagLog('system', 'Media compression skipped', {
        kind: mediaKind,
        reason: 'webcodecs-unsupported',
      });
      return file;
    }

    diagLog('system', 'Media compression started', {
      kind: mediaKind,
      filename: file.name,
      originalBytes: file.size,
      quality:
        mediaKind === 'video'
          ? settings.video.quality
          : mediaKind === 'audio'
            ? settings.audio.quality
            : settings.image.quality,
    });

    const startedAt = performance.now();
    let compressed: File;
    try {
      const onProgress = (percent: number) => {
        const status: UploadStatus = {
          phase: 'compressing',
          percent,
          mediaKind,
          filename: file.name,
          originalBytes: file.size,
          fileIndex,
          totalFiles,
        };
        onStatus(status);
        this.emitStatus(status);
      };
      compressed =
        mediaKind === 'video'
          ? await service.compressVideo(file, settings.video, onProgress)
          : mediaKind === 'audio'
            ? await service.compressAudio(file, settings.audio, onProgress)
            : await service.compressImage(file, settings.image, onProgress);
    } catch (err) {
      diagLog('system', 'Media compression failed', {
        kind: mediaKind,
        error: String(err),
      });
      ToastService.show('Compression failed, uploading original.', 'info');
      return file;
    }

    if (compressed.size >= file.size) {
      diagLog(
        'system',
        'Compressed file larger than original — using original',
        {
          kind: mediaKind,
          originalBytes: file.size,
          compressedBytes: compressed.size,
        }
      );
      // Surface this in the overlay so the user sees the compression DID run
      // and we deliberately kept the original. Without this, the overlay would
      // jump straight from "Compressing…" to "Uploading…" with no closure.
      const noBenefitStatus: UploadStatus = {
        phase: 'compressed',
        percent: 100,
        mediaKind,
        filename: file.name,
        originalBytes: file.size,
        compressedBytes: file.size, // same — overlay will render "Already well-compressed"
        fileIndex,
        totalFiles,
      };
      onStatus(noBenefitStatus);
      this.emitStatus(noBenefitStatus);
      return file;
    }

    const durationMs = Math.round(performance.now() - startedAt);
    diagLog('system', 'Media compression complete', {
      kind: mediaKind,
      originalBytes: file.size,
      compressedBytes: compressed.size,
      durationMs,
    });

    const status: UploadStatus = {
      phase: 'compressed',
      percent: 100,
      mediaKind,
      filename: file.name,
      originalBytes: file.size,
      compressedBytes: compressed.size,
      fileIndex,
      totalFiles,
    };
    onStatus(status);
    this.emitStatus(status);

    return compressed;
  }

  private validateFileType(file: File): { valid: boolean; error?: string } {
    if (!/^(image|video|audio)\//.test(file.type)) {
      return {
        valid: false,
        error:
          'Unsupported file type. Only images, videos, and audio are allowed.',
      };
    }
    return { valid: true };
  }

  private validateFileSize(
    file: File,
    settings: MediaServerSettings
  ): { valid: boolean; error?: string } {
    const maxSize =
      settings.maxFileSize ||
      (settings.protocol === 'blossom'
        ? this.DEFAULT_BLOSSOM_MAX_FILE_SIZE
        : this.DEFAULT_NIP96_MAX_FILE_SIZE);

    if (file.size > maxSize) {
      const fileSizeMB = (file.size / 1024 / 1024).toFixed(1);
      const maxSizeMB = Math.floor(maxSize / 1024 / 1024);
      return {
        valid: false,
        error: `File too large (${fileSizeMB} MB). Maximum size: ${maxSizeMB} MB`,
      };
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
    return this.authService.signEventWithTimeout(event, this.SIGN_TIMEOUT_MS);
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
        ['expiration', (now + 300).toString()],
      ],
      content: 'Upload file',
      pubkey: currentUser.pubkey,
    });

    return `Nostr ${btoa(JSON.stringify(signedEvent))}`;
  }

  private async createNIP98Auth(
    method: string,
    url: string,
    sha256: string
  ): Promise<string> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('Not authenticated');

    const signedEvent = await this.signEventWithTimeout({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['u', url],
        ['method', method],
        ['payload', sha256],
      ],
      content: '',
      pubkey: currentUser.pubkey,
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
        return await this.uploadBlossomBrowser(
          file,
          serverUrl,
          authHeader,
          onProgress
        );
      }

      // Desktop mode: Use adapter (CORS bypassed)
      const response = await this.uploadAdapter.upload({
        url: `${serverUrl}/upload`,
        method: 'PUT',
        headers: {
          Authorization: authHeader,
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
        onProgress: percent => onProgress?.(this.mapUploadProgress(percent)),
      });

      if (response.ok) {
        const descriptor = await response.json();
        onProgress?.(100);
        return { success: true, url: descriptor.url };
      }

      return this.errorResult(
        this.describeUploadFailure(response.status, response.statusText)
      );
    } catch (error) {
      console.error('Blossom upload error:', error);
      return this.errorResult(
        `Upload error: ${error instanceof Error ? error.message : error}`
      );
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
          Authorization: authHeader,
        },
        body: file,
      });

      onProgress?.(90);

      if (response.ok) {
        const descriptor = await response.json();
        onProgress?.(100);
        return { success: true, url: descriptor.url };
      }

      const errorText = await response.text();
      return this.errorResult(
        this.describeUploadFailure(
          response.status,
          response.statusText,
          errorText
        )
      );
    } catch (error) {
      console.error('Blossom browser upload error:', error);
      return this.errorResult(
        `Upload error: ${error instanceof Error ? error.message : 'Network error - server may not support CORS'}`
      );
    }
  }

  private async fetchNIP96ConfigFromUrl(
    url: string
  ): Promise<{ api_url: string } | null> {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      console.debug('Failed to fetch NIP-96 config:', error);
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

  private async buildMultipartBody(
    file: File,
    fields: Record<string, string>
  ): Promise<{ body: ArrayBuffer; boundary: string }> {
    const boundary = `----WebKitFormBoundary${Math.random().toString(36).substring(2)}`;
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];

    for (const [key, value] of Object.entries(fields)) {
      parts.push(
        encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
        )
      );
    }

    parts.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`
      )
    );
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
        return await this.uploadNIP96Browser(
          file,
          proxiedApiUrl,
          authHeader,
          onProgress
        );
      }

      // Desktop mode: manual multipart (existing behavior)
      const { body, boundary } = await this.buildMultipartBody(file, {
        content_type: file.type,
        size: file.size.toString(),
      });

      const response = await this.uploadAdapter.upload({
        url: apiUrl,
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
        onProgress: percent => onProgress?.(this.mapUploadProgress(percent)),
      });

      if (response.ok) {
        const result = await response.json();
        if (result.status === 'success' && result.nip94_event) {
          const urlTag = result.nip94_event.tags.find(
            (t: string[]) => t[0] === 'url'
          );
          if (urlTag) {
            onProgress?.(100);
            return { success: true, url: urlTag[1] };
          }
        }
        return this.errorResult('No URL in upload response');
      }

      return this.errorResult(
        this.describeUploadFailure(response.status, response.statusText)
      );
    } catch (error) {
      console.error('NIP-96 upload error:', error);
      return this.errorResult(
        `Upload error: ${error instanceof Error ? error.message : error}`
      );
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
    return new Promise(resolve => {
      const formData = new FormData();
      formData.append('file', file);

      const xhr = new XMLHttpRequest();

      xhr.upload.onprogress = event => {
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
              const urlTag = result.nip94_event.tags.find(
                (t: string[]) => t[0] === 'url'
              );
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
          resolve(
            this.errorResult(
              this.describeUploadFailure(
                xhr.status,
                xhr.statusText,
                xhr.responseText
              )
            )
          );
        }
      };

      xhr.onerror = () => {
        resolve(
          this.errorResult('Network error - server may not support CORS')
        );
      };

      xhr.open('POST', apiUrl);
      xhr.setRequestHeader('Authorization', authHeader);
      // DO NOT set Content-Type - browser sets it automatically with correct boundary
      xhr.send(formData);
    });
  }

  public async uploadFile(
    file: File,
    onProgress?: ProgressCallback
  ): Promise<UploadResult> {
    return this.uploadFileInternal(file, onProgress);
  }

  /**
   * Internal upload path that supports rich UploadStatus events alongside
   * the legacy onProgress callback. Used by uploadFiles() to thread batch
   * indices into the global progress overlay.
   */
  private async uploadFileInternal(
    file: File,
    onProgress?: ProgressCallback,
    fileIndex?: number,
    totalFiles?: number
  ): Promise<UploadResult> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        const errorMsg = 'Please log in to upload files';
        ToastService.show(errorMsg, 'error');
        return this.errorResult(errorMsg);
      }

      const settings = this.loadMediaServerSettings();

      // Type validation runs before compression — no point compressing a file
      // we wouldn't accept anyway.
      const typeCheck = this.validateFileType(file);
      if (!typeCheck.valid) {
        ToastService.show(typeCheck.error || 'Invalid file', 'error');
        return this.errorResult(typeCheck.error || 'Invalid file');
      }

      const mediaKind = detectMediaKind(file);
      const originalBytes = file.size;

      // Best-effort compression for video/audio. Falls back to the original
      // file on skip / failure, never blocks the upload.
      const noopStatus = (_s: UploadStatus) => {
        /* events still go via emitStatus */
      };
      const fileToUpload = await this.maybeCompressMedia(
        file,
        mediaKind,
        noopStatus,
        fileIndex,
        totalFiles
      );

      // Size validation runs AFTER compression so videos that exceed the
      // server's free-tier limit may still pass once compressed. The whole
      // point of pre-upload compression is to make oversized media uploadable.
      const sizeCheck = this.validateFileSize(fileToUpload, settings);
      if (!sizeCheck.valid) {
        ToastService.show(sizeCheck.error || 'File too large', 'error');
        return this.errorResult(sizeCheck.error || 'File too large');
      }

      // Wrap the legacy progress callback so the global overlay also sees the
      // upload phase. Existing callers' button-replaced-with-circle UI keeps
      // working through onProgress unchanged.
      const wrappedProgress: ProgressCallback = percent => {
        onProgress?.(percent);
        this.emitStatus({
          phase: 'uploading',
          percent,
          mediaKind,
          filename: file.name,
          originalBytes,
          compressedBytes:
            fileToUpload.size !== originalBytes ? fileToUpload.size : undefined,
          fileIndex,
          totalFiles,
        });
      };

      const result =
        settings.protocol === 'blossom'
          ? await this.uploadBlossom(
              fileToUpload,
              settings.url,
              wrappedProgress
            )
          : await this.uploadNIP96(fileToUpload, settings.url, wrappedProgress);

      if (result.success) {
        this.emitStatus({
          phase: 'uploaded',
          percent: 100,
          mediaKind,
          filename: file.name,
          originalBytes,
          compressedBytes:
            fileToUpload.size !== originalBytes ? fileToUpload.size : undefined,
          fileIndex,
          totalFiles,
        });
      }

      ToastService.show(
        result.success
          ? 'File uploaded successfully!'
          : result.error || 'Upload failed',
        result.success ? 'success' : 'error'
      );

      return result;
    } catch (error) {
      ErrorService.handle(
        error,
        'MediaUploadService.uploadFile',
        true,
        'Failed to upload file'
      );
      return this.errorResult(
        error instanceof Error ? error.message : 'Upload failed'
      );
    }
  }

  public async uploadFiles(
    files: File[],
    onProgress?: (
      fileIndex: number,
      progress: number,
      totalFiles: number
    ) => void
  ): Promise<UploadResult[]> {
    const results: UploadResult[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;
      const result = await this.uploadFileInternal(
        file,
        progress => {
          onProgress?.(i, progress, files.length);
        },
        i,
        files.length
      );
      results.push(result);

      if (!result.success) break;
    }

    return results;
  }

  public cancelUpload(): void {
    this.uploadAdapter.abort();
  }
}
