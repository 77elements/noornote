/**
 * PostEditorToolbar Component
 * Reusable toolbar for post editor with Upload and Emoji buttons
 *
 * Features:
 * - File upload with progress indicator
 * - Emoji picker integration
 * - Modular and reusable
 */

import { ModuleLoader } from '../../core/ModuleLoader';
import type { MediaModuleApi } from '../../modules/media/contracts';
import { SystemLogger } from '../../services/SystemLogger';
import { ModalService } from '../../services/ModalService';
import { EmojiPicker, type CustomEmojiEntry } from '../emoji/EmojiPicker';
import { isCustomEmojisEnabled } from '../../addons/custom-emojis/index';

export interface PostEditorToolbarConfig {
  onMediaUploaded: (url: string) => void;
  onEmojiSelected: (emoji: string) => void;
  onPollToggle?: () => void;
  onScheduleClick?: () => void;
  textareaSelector: string;
  showPoll?: boolean; // Default: true
  showSchedule?: boolean; // Default: false — caller sets via isScheduledPostsEnabled()
}

export class PostEditorToolbar {
  private config: PostEditorToolbarConfig;
  private _mediaApi?: MediaModuleApi | null;
  private get mediaApi(): MediaModuleApi | null {
    return (this._mediaApi ??=
      ModuleLoader.getInstance().getApi<MediaModuleApi>('media'));
  }
  private systemLogger: SystemLogger;
  private modalService: ModalService;
  private emojiPicker: EmojiPicker | null = null;
  private container: HTMLElement | null = null;

  constructor(config: PostEditorToolbarConfig) {
    this.config = config;
    this.systemLogger = SystemLogger.getInstance();
    this.modalService = ModalService.getInstance();
  }

  /**
   * Render toolbar HTML
   */
  public render(): string {
    const showPoll = this.config.showPoll !== false; // Default: true
    const pollButtonHtml = showPoll
      ? `<button class="btn-icon" data-action="poll" title="Create poll">POLL</button>`
      : '';
    const scheduleButtonHtml = this.config.showSchedule
      ? `<button class="btn-icon" data-action="schedule" title="Schedule post">
          <svg width="20" height="20"><use href="#icon-calendar"/></svg>
        </button>`
      : '';

    return `
      <div class="post-note-toolbar">
        <input type="file" accept="image/*,video/*,audio/*" multiple style="display: none;" data-file-input />
        <button class="btn-icon" data-action="upload" title="Upload media">
          <svg width="20" height="20"><use href="#icon-upload"/></svg>
        </button>
        <button class="btn-icon" data-action="emoji" title="Insert emoji">
          <svg width="20" height="20"><use href="#icon-emoji"/></svg>
        </button>
        ${pollButtonHtml}
        ${scheduleButtonHtml}
      </div>
    `;
  }

  /**
   * Setup event listeners after rendering
   */
  public setupEventListeners(container: HTMLElement): void {
    this.container = container;

    // Upload button
    const uploadBtn = container.querySelector('[data-action="upload"]');
    const fileInput = container.querySelector(
      '[data-file-input]'
    ) as HTMLInputElement;

    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener('click', () => {
        fileInput.click();
      });

      fileInput.addEventListener('change', e => {
        const target = e.target as HTMLInputElement;
        if (target.files && target.files.length > 0) {
          void this.handleFileUpload(Array.from(target.files));
        }
      });
    }

    // Emoji button
    const emojiBtn = container.querySelector('[data-action="emoji"]');
    if (emojiBtn) {
      emojiBtn.addEventListener('click', () => {
        void this.handleEmojiPicker();
      });
    }

    // Poll button
    const pollBtn = container.querySelector('[data-action="poll"]');
    if (pollBtn && this.config.onPollToggle) {
      pollBtn.addEventListener('click', () => {
        this.config.onPollToggle?.();
      });
    }

    // Schedule button (only rendered when showSchedule is true)
    const scheduleBtn = container.querySelector('[data-action="schedule"]');
    if (scheduleBtn && this.config.onScheduleClick) {
      scheduleBtn.addEventListener('click', () => {
        this.config.onScheduleClick?.();
      });
    }
  }

  /**
   * Handle file upload (single or multiple files). Public so other entry points
   * (e.g. paste-to-upload in the editor) can reuse the exact same upload + insert
   * + progress + error path as the upload button.
   */
  public async handleFileUpload(files: File[]): Promise<void> {
    if (!this.container || files.length === 0) return;

    const uploadBtn = this.container.querySelector(
      '[data-action="upload"]'
    ) as HTMLButtonElement;
    if (!uploadBtn) return;

    // Show uploading state: a transparent ring whose green border fills as the
    // upload progresses. Kept INLINE on purpose (not a sprite <use>): the bar's
    // stroke-dashoffset is animated from updateUploadProgress(), which can't reach
    // a circle inside a <use> shadow tree.
    const originalHTML = uploadBtn.innerHTML;
    uploadBtn.disabled = true;
    uploadBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" class="upload-progress">
        <circle class="upload-progress-bg" cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" opacity="0.2"></circle>
        <circle class="upload-progress-bar" cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="62.83" stroke-dashoffset="62.83"></circle>
      </svg>
    `;

    try {
      const api = this.mediaApi;
      if (!api) {
        this.systemLogger.error('PostEditorToolbar', 'Media module not loaded');
        this.modalService.show({
          title: 'Upload Failed',
          content:
            '<p>Media module is not available. Please try again later.</p>',
          showCloseButton: true,
        });
        return;
      }

      const firstFile = files[0];
      if (files.length === 1 && firstFile) {
        // Single file upload
        const result = await api.uploadFile(firstFile, progress => {
          this.updateUploadProgress(progress);
        });

        if (result.success && result.url) {
          this.config.onMediaUploaded(result.url);
          this.systemLogger.info(
            'PostEditorToolbar',
            'Media uploaded successfully'
          );
        } else {
          this.systemLogger.error(
            'PostEditorToolbar',
            `Upload failed: ${result.error}`
          );
          this.modalService.show({
            title: 'Upload Failed',
            content: `<p>${result.error || 'Unknown error occurred'}</p>`,
            showCloseButton: true,
          });
        }
      } else {
        // Multiple files upload
        const results = await api.uploadFiles(files, progress => {
          this.updateUploadProgress(Math.min(progress, 99));
        });

        // Insert all successful URLs
        const successfulUploads = results.filter(r => r.success && r.url);
        if (successfulUploads.length > 0) {
          const urls = successfulUploads.map(r => r.url).join('\n\n');
          this.config.onMediaUploaded(urls);
          this.systemLogger.info(
            'PostEditorToolbar',
            `${successfulUploads.length}/${files.length} files uploaded successfully`
          );
        }

        // Show errors if any
        const failures = results.filter(r => !r.success);
        if (failures.length > 0) {
          const errorMessages = failures.map(r => r.error).join('<br>');
          this.modalService.show({
            title: 'Some Uploads Failed',
            content: `<p>${failures.length} file(s) failed:</p><p style="font-size: 0.9rem;">${errorMessages}</p>`,
            showCloseButton: true,
          });
        }
      }
    } catch (error) {
      console.error('Upload error:', error);
      this.systemLogger.error(
        'PostEditorToolbar',
        `Upload error: ${String(error)}`
      );
      this.modalService.show({
        title: 'Upload Failed',
        content: '<p>Upload failed. Please try again.</p>',
        showCloseButton: true,
      });
    } finally {
      // Restore button state
      uploadBtn.disabled = false;
      uploadBtn.innerHTML = originalHTML;

      // Reset file input
      const fileInput = this.container?.querySelector(
        '[data-file-input]'
      ) as HTMLInputElement;
      if (fileInput) {
        fileInput.value = '';
      }
    }
  }

  /**
   * Update upload progress circle
   */
  private updateUploadProgress(progress: number): void {
    if (!this.container) return;

    const progressBar = this.container.querySelector(
      '.upload-progress-bar'
    ) as SVGCircleElement;
    if (!progressBar) return;

    // Circle circumference: 2 * PI * radius = 2 * PI * 10 = 62.83
    const circumference = 62.83;
    const offset = circumference - (progress / 100) * circumference;

    progressBar.style.strokeDashoffset = offset.toString();
  }

  /**
   * Handle emoji picker
   */
  private async handleEmojiPicker(): Promise<void> {
    const textarea = document.querySelector(
      this.config.textareaSelector
    ) as HTMLTextAreaElement;
    const emojiBtn = this.container?.querySelector(
      '[data-action="emoji"]'
    ) as HTMLElement;
    if (!textarea || !emojiBtn) return;

    // Always destroy old picker and create fresh one to ensure correct positioning
    if (this.emojiPicker) {
      this.emojiPicker.destroy();
      this.emojiPicker = null;
    }

    // Custom emojis (NIP-30) — only loaded when the addon is enabled
    let customEmojis: CustomEmojiEntry[] | undefined;
    if (isCustomEmojisEnabled()) {
      try {
        const { EmojiService } = await import(
          '../../addons/custom-emojis/EmojiService'
        );
        const service = EmojiService.getInstance();
        // Fire-and-forget refresh in background — initial render uses cached pack
        void service.refreshFromRelays();
        customEmojis = service.getEmojis();
      } catch (err) {
        this.systemLogger.warn(
          'PostEditorToolbar',
          `Custom emoji load failed: ${String(err)}`
        );
      }
    }

    // Create new picker with current DOM element
    this.emojiPicker = new EmojiPicker({
      triggerElement: emojiBtn,
      ...(customEmojis ? { customEmojis } : {}),
      onSelect: (emoji: string) => {
        this.config.onEmojiSelected(emoji);
        this.emojiPicker?.hide();
      },
    });

    // Show picker
    this.emojiPicker.show();
  }

  /**
   * Hide emoji picker if open
   */
  public hideEmojiPicker(): void {
    if (this.emojiPicker) {
      this.emojiPicker.hide();
    }
  }

  /**
   * Cleanup resources
   */
  public destroy(): void {
    if (this.emojiPicker) {
      this.emojiPicker.destroy();
      this.emojiPicker = null;
    }
    this.container = null;
  }
}
