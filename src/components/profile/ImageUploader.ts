/**
 * ImageUploader Component
 * Reusable image upload component for profile avatars and banners
 *
 * Features:
 * - Click to upload (hidden file input)
 * - Progress indicator during upload (same as PostEditorToolbar)
 * - Preview of current image
 * - Upload icon overlay
 * - Uses MediaUploadService (configured in Settings)
 */

import { ModuleLoader } from '../../core/ModuleLoader';
import type { MediaModuleApi } from '../../modules/media/contracts';
import { SystemLogger } from '../../services/SystemLogger';
import { ToastService } from '../../services/ToastService';

export interface ImageUploaderConfig {
  /** Current image URL (optional) */
  currentUrl?: string;
  /** Callback when upload succeeds */
  onUploadSuccess: (url: string) => void;
  /** Callback when upload starts (optional) */
  onUploadStart?: () => void;
  /** Callback when upload ends (optional) */
  onUploadEnd?: () => void;
  /** Progress callback (0-100) */
  onProgress?: (percent: number) => void;
  /** Media type (avatar or banner) */
  mediaType: 'avatar' | 'banner';
  /** Additional CSS class (optional) */
  className?: string;
}

export class ImageUploader {
  private config: ImageUploaderConfig;
  private mediaApi: MediaModuleApi | null = null;
  private systemLogger: SystemLogger;
  private container: HTMLElement | null = null;
  private fileInput: HTMLInputElement | null = null;
  private uploading: boolean = false;
  private originalIconHTML: string = '';

  constructor(config: ImageUploaderConfig) {
    this.config = config;
    this.mediaApi = ModuleLoader.getInstance().getApi<MediaModuleApi>('media');
    this.systemLogger = SystemLogger.getInstance();
  }

  /**
   * Render uploader HTML
   */
  public render(): string {
    const { currentUrl, mediaType, className } = this.config;
    const extraClass = className || '';
    const typeClass = mediaType === 'avatar' ? 'image-uploader-avatar' : 'image-uploader-banner';

    const backgroundStyle = currentUrl
      ? `background-image: url('${currentUrl}')`
      : '';

    // Store original icon HTML for later restoration
    this.originalIconHTML = `
      <svg class="upload-icon" width="32" height="32"><use href="#icon-upload"/></svg>
    `;

    return `
      <div class="image-uploader ${typeClass} ${extraClass}" data-uploader>
        <input
          type="file"
          accept="image/*"
          style="display: none;"
          data-file-input
        />
        <div class="image-uploader-preview" style="${backgroundStyle}" data-preview>
          <div class="image-uploader-overlay" data-overlay>
            <div class="upload-icon-container" data-icon-container>
              ${this.originalIconHTML}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Setup event listeners after rendering
   */
  public setupEventListeners(container: HTMLElement): void {
    this.container = container;
    this.fileInput = container.querySelector('[data-file-input]') as HTMLInputElement;
    const uploadArea = container.querySelector('[data-uploader]') as HTMLElement;

    if (!this.fileInput || !uploadArea) {
      this.systemLogger.error('ImageUploader', 'Failed to find file input or upload area');
      return;
    }

    // Click on upload area triggers file picker
    uploadArea.addEventListener('click', () => {
      if (!this.uploading) {
        this.fileInput?.click();
      }
    });

    // Handle file selection
    this.fileInput.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      if (file) {
        this.handleFileUpload(file);
      }
    });
  }

  /**
   * Handle file upload
   */
  private async handleFileUpload(file: File): Promise<void> {
    if (!this.container || this.uploading) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      ToastService.show('Please select an image file', 'error');
      return;
    }

    this.uploading = true;
    this.config.onUploadStart?.();

    // Show progress indicator (replace icon with progress circle)
    this.showProgressCircle();

    try {
      const api = this.mediaApi ?? ModuleLoader.getInstance().getApi<MediaModuleApi>('media');
      if (!api) {
        ToastService.show('Media module is not available. Please try again later.', 'error');
        return;
      }

      // Upload via media module
      const result = await api.uploadFile(file, (progress) => {
        this.updateProgress(progress);
        this.config.onProgress?.(progress);
      });

      if (result.success && result.url) {
        // Update preview
        this.updatePreview(result.url);

        // Notify success
        this.config.onUploadSuccess(result.url);
        this.systemLogger.info('ImageUploader', `${this.config.mediaType} uploaded successfully`);
      } else {
        ToastService.show(result.error || 'Upload failed. Please try again.', 'error');
      }
    } catch (error) {
      this.systemLogger.error('ImageUploader', 'Upload error:', error);
      ToastService.show('Upload failed. Please try again.', 'error');
    } finally {
      this.uploading = false;
      this.restoreIcon();
      this.config.onUploadEnd?.();

      // Reset file input
      if (this.fileInput) {
        this.fileInput.value = '';
      }
    }
  }

  /**
   * Show progress circle (replace icon with uploading circle - same as PostEditorToolbar)
   */
  private showProgressCircle(): void {
    if (!this.container) return;

    const uploader = this.container.querySelector('[data-uploader]') as HTMLElement;
    const overlay = this.container.querySelector('[data-overlay]') as HTMLElement;
    const iconContainer = this.container.querySelector('[data-icon-container]') as HTMLElement;
    if (!iconContainer) return;

    // Disable clicks during upload
    if (uploader) {
      uploader.style.cursor = 'default';
      uploader.style.pointerEvents = 'none';
    }

    // Make overlay visible during upload
    if (overlay) {
      overlay.style.opacity = '1';
    }

    // Replace icon with progress circle (same as PostEditorToolbar)
    iconContainer.innerHTML = `
      <svg width="32" height="32" class="upload-progress"><use href="#icon-upload-progress"/></svg>
    `;
  }

  /**
   * Restore original upload icon
   */
  private restoreIcon(): void {
    if (!this.container) return;

    const uploader = this.container.querySelector('[data-uploader]') as HTMLElement;
    const overlay = this.container.querySelector('[data-overlay]') as HTMLElement;
    const iconContainer = this.container.querySelector('[data-icon-container]') as HTMLElement;
    if (!iconContainer) return;

    // Re-enable clicks
    if (uploader) {
      uploader.style.cursor = '';
      uploader.style.pointerEvents = '';
    }

    // Reset overlay to default (hover-only)
    if (overlay) {
      overlay.style.opacity = '';
    }

    iconContainer.innerHTML = this.originalIconHTML;
  }

  /**
   * Update progress circle (same calculation as PostEditorToolbar)
   */
  private updateProgress(percent: number): void {
    if (!this.container) return;

    const progressBar = this.container.querySelector('.upload-progress-bar') as SVGCircleElement;
    if (!progressBar) return;

    // Circle circumference: 2 * PI * radius = 2 * PI * 10 = 62.83
    const circumference = 62.83;
    const offset = circumference - (percent / 100) * circumference;

    progressBar.style.strokeDashoffset = offset.toString();
  }

  /**
   * Update preview image
   */
  private updatePreview(url: string): void {
    if (!this.container) return;

    const preview = this.container.querySelector('[data-preview]') as HTMLElement;
    if (preview) {
      preview.style.backgroundImage = `url('${url}')`;
    }
  }

  /**
   * Cleanup (remove event listeners)
   */
  public cleanup(): void {
    this.container = null;
    this.fileInput = null;
  }
}
