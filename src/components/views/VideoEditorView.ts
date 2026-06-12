/**
 * VideoEditorView Component
 * Full-page editor for creating and publishing video events (NIP-71)
 *
 * Features:
 * - Video upload with drag & drop + click-to-upload
 * - Auto-detect landscape (Kind 21) / portrait (Kind 22) from dimensions
 * - Thumbnail upload
 * - Title, description, tags
 * - Emoji picker (via PostEditorToolbar)
 * - Relay selector
 */

import { View } from './View';
import { Router } from '../../services/Router';
import type { VideoOptions } from '../../modules/media/contracts';
import { RelayConfig } from '../../services/RelayConfig';
import { AuthGuard } from '../../services/AuthGuard';
import { SystemLogger } from '../../services/SystemLogger';
import { RelaySelector } from '../post/RelaySelector';
import { PostEditorToolbar } from '../post/PostEditorToolbar';
import { setupPasteUpload } from '../../helpers/pasteUpload';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { MediaModuleApi } from '../../modules/media/contracts';
import { ToastService } from '../../services/ToastService';
import { escapeHtml } from '../../helpers/escapeHtml';

type DetectedKind = 21 | 22;

export class VideoEditorView extends View {
  private container: HTMLElement;
  private router: Router;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;
  private _mediaApi?: MediaModuleApi | null;
  private get mediaApi(): MediaModuleApi | null {
    return this._mediaApi ??= ModuleLoader.getInstance().getApi<MediaModuleApi>('media');
  }

  // Sub-components
  private relaySelector: RelaySelector | null = null;
  private toolbar: PostEditorToolbar | null = null;

  // State
  private videoUrl: string = '';
  private videoMimeType: string = '';
  private videoDimensions: { width: number; height: number } | null = null;
  private detectedKind: DetectedKind = 21;
  private kindOverride: boolean = false;
  private thumbnailUrl: string = '';
  private title: string = '';
  private content: string = '';
  private tags: string = '';
  private selectedRelays: Set<string> = new Set();
  private availableRelays: string[] = [];
  private isTestMode: boolean = false;
  private isPublishing: boolean = false;
  private isVideoUploading: boolean = false;
  private isThumbnailUploading: boolean = false;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--video-editor';
    this.router = Router.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();

    this.loadRelayConfiguration();
    this.render();
  }

  private loadRelayConfiguration(): void {
    const localRelaySettings = this.relayConfig.loadLocalRelaySettings();

    if (localRelaySettings.enabled) {
      this.isTestMode = true;
      this.availableRelays = [localRelaySettings.url];
      this.selectedRelays = new Set([localRelaySettings.url]);
    } else {
      this.isTestMode = false;
      const allRelays = this.relayConfig.getAllRelays();
      const uniqueRelayUrls = [...new Set(allRelays.filter(r => r.isActive).map(r => r.url))];
      this.availableRelays = uniqueRelayUrls;
      const writeRelays = [...new Set(this.relayConfig.getWriteRelays())];
      this.selectedRelays = new Set(writeRelays);
    }
  }


  private render(): void {
    this.relaySelector = new RelaySelector({
      availableRelays: this.availableRelays,
      selectedRelays: this.selectedRelays,
      isTestMode: this.isTestMode,
      onChange: (selectedRelays) => {
        this.selectedRelays = selectedRelays;
        this.updateButtonStates();
      }
    });

    this.toolbar = new PostEditorToolbar({
      // The video itself is uploaded separately; toolbar/paste media is inserted
      // into the description text (e.g. a thumbnail or extra image URL).
      onMediaUploaded: (url) => this.insertAtCursor(url),
      onEmojiSelected: (emoji) => this.insertAtCursor(emoji),
      textareaSelector: '.video-editor-description',
      showPoll: false
    });

    this.container.innerHTML = `
      <div class="video-editor">
        <header class="video-editor__header">
          <button class="video-editor__back" data-action="back">
            <svg width="24" height="24"><use href="#icon-back"/></svg>
            Back
          </button>
          <h1 class="video-editor__title">Post Video</h1>
        </header>

        <div class="video-editor__toolbar">
          ${this.relaySelector.render()}
        </div>

        <div class="video-editor__body">
          ${this.renderForm()}
        </div>

        <footer class="video-editor__footer">
          ${this.toolbar.render()}
          <div class="video-editor__actions">
            <button class="btn" data-action="publish" disabled>Publish</button>
          </div>
        </footer>
      </div>
    `;

    this.setupEventListeners();
  }

  private renderForm(): string {
    return `
      <div class="video-editor__form">
        <div class="form__row">
          <label>Video</label>
          ${this.renderUploadZone()}
        </div>

        <div class="form__row">
          <label for="video-title">Title</label>
          <input
            type="text"
            id="video-title"
            class="input"
            placeholder="Video title (optional)"
            value="${escapeHtml(this.title)}"
            data-field="title"
          />
        </div>

        <div class="form__row">
          <label for="video-description">Description</label>
          <textarea
            id="video-description"
            class="textarea video-editor-description"
            placeholder="Describe your video..."
            data-field="content"
          >${escapeHtml(this.content)}</textarea>
        </div>

        <section class="nn-ui-toggle">
          <div class="nn-ui-toggle__header">
            <div class="nn-ui-toggle__info">
              <h2 class="nn-ui-toggle__title">Details</h2>
            </div>
            <button class="nn-ui-toggle__toggle" aria-label="Toggle section">
              <svg width="24" height="24"><use href="#icon-chevron-down"/></svg>
            </button>
          </div>
          <div class="nn-ui-toggle__content">
            <div class="form__row">
              <label>Thumbnail</label>
              <div class="video-editor__thumb-input">
                <input
                  type="text"
                  class="input"
                  placeholder="https://... or upload"
                  value="${escapeHtml(this.thumbnailUrl)}"
                  data-field="thumbnailUrl"
                />
                <button type="button" class="video-editor__upload-btn" data-action="upload-thumbnail" title="Upload thumbnail">
                  <svg width="18" height="18"><use href="#icon-upload"/></svg>
                </button>
                <input type="file" accept="image/*" class="video-editor__thumb-file" data-thumb-file style="display: none;" />
              </div>
            </div>

            <div class="form__row">
              <label for="video-tags">Tags</label>
              <input
                type="text"
                id="video-tags"
                class="input"
                placeholder="nostr, music, tutorial (comma separated)"
                value="${escapeHtml(this.tags)}"
                data-field="tags"
              />
            </div>
          </div>
        </section>
      </div>
    `;
  }

  private renderUploadZone(): string {
    if (this.videoUrl) {
      return `
        <div class="video-editor__preview">
          <video
            class="video-editor__video"
            src="${escapeHtml(this.videoUrl)}"
            controls
            preload="metadata"
          ></video>
          <div class="video-editor__video-info">
            <span class="video-editor__kind-badge" data-kind="${this.detectedKind}">
              ${this.detectedKind === 21 ? 'Landscape' : 'Portrait'} (Kind ${this.detectedKind})
            </span>
            ${this.videoDimensions ? `<span class="video-editor__dimensions">${this.videoDimensions.width}x${this.videoDimensions.height}</span>` : ''}
            <button type="button" class="video-editor__toggle-kind" data-action="toggle-kind" title="Switch orientation">
              <svg width="16" height="16"><use href="#icon-switch-arrows"/></svg>
            </button>
            <button type="button" class="video-editor__remove-video" data-action="remove-video" title="Remove video">
              <svg width="16" height="16"><use href="#icon-close"/></svg>
            </button>
          </div>
        </div>
      `;
    }

    if (this.isVideoUploading) {
      return `
        <div class="video-editor__upload-zone video-editor__upload-zone--uploading">
          <svg class="spin" width="32" height="32"><use href="#icon-spin-loader"/></svg>
          <span>Uploading video...</span>
        </div>
      `;
    }

    return `
      <div class="video-editor__upload-zone" data-action="upload-video">
        <svg width="32" height="32"><use href="#icon-video"/></svg>
        <span>Click or drag & drop to upload video</span>
        <input type="file" accept="video/*" class="video-editor__video-file" data-video-file style="display: none;" />
      </div>
    `;
  }

  private setupEventListeners(): void {
    // Back button
    const backBtn = this.container.querySelector('[data-action="back"]');
    backBtn?.addEventListener('click', () => this.router.navigate('/'));

    // Field inputs
    this.setupFieldListeners();

    // Accordion toggle
    this.container.querySelectorAll('.nn-ui-toggle__header').forEach(header => {
      header.addEventListener('click', () => header.closest('.nn-ui-toggle')?.classList.toggle('open'));
    });

    // Relay selector
    const relaySelectorContainer = this.container.querySelector('.post-note-relay-selector');
    if (this.relaySelector && relaySelectorContainer) {
      this.relaySelector.setupEventListeners(relaySelectorContainer as HTMLElement);
    }

    // Footer toolbar (emoji)
    const toolbarContainer = this.container.querySelector('.post-note-toolbar');
    if (this.toolbar && toolbarContainer) {
      this.toolbar.setupEventListeners(toolbarContainer as HTMLElement);
    }

    // Paste-to-upload into the video description.
    const pasteTarget = this.container.querySelector('.video-editor-description') as HTMLElement | null;
    if (pasteTarget) setupPasteUpload(pasteTarget, files => void this.toolbar?.handleFileUpload(files));

    // Video upload zone
    this.setupVideoUpload();

    // Thumbnail upload
    this.setupThumbnailUpload();

    // Publish button
    const publishBtn = this.container.querySelector('[data-action="publish"]');
    publishBtn?.addEventListener('click', () => this.handlePublish());

    // Kind toggle + remove video (delegated, since they appear after upload)
    this.container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const action = target.closest('[data-action]')?.getAttribute('data-action');
      if (action === 'toggle-kind') this.handleToggleKind();
      if (action === 'remove-video') this.handleRemoveVideo();
    });
  }

  private setupFieldListeners(): void {
    const fields = this.container.querySelectorAll('[data-field]');
    fields.forEach(field => {
      field.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement | HTMLTextAreaElement;
        const fieldName = target.dataset.field;

        if (fieldName === 'title') this.title = target.value;
        else if (fieldName === 'content') this.content = target.value;
        else if (fieldName === 'tags') this.tags = target.value;
        else if (fieldName === 'thumbnailUrl') this.thumbnailUrl = target.value;

        this.updateButtonStates();
      });
    });
  }

  private setupVideoUpload(): void {
    const zone = this.container.querySelector('[data-action="upload-video"]');
    const fileInput = this.container.querySelector('[data-video-file]') as HTMLInputElement;
    if (!zone || !fileInput) return;

    // Click to upload
    zone.addEventListener('click', () => fileInput.click());

    // File selected
    fileInput.addEventListener('change', async (e) => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      if (file) {
        await this.handleVideoUpload(file);
        target.value = '';
      }
    });

    // Drag & drop
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('video-editor__upload-zone--dragover');
    });
    zone.addEventListener('dragleave', () => {
      zone.classList.remove('video-editor__upload-zone--dragover');
    });
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.classList.remove('video-editor__upload-zone--dragover');
      const file = (e as DragEvent).dataTransfer?.files[0];
      if (file && file.type.startsWith('video/')) {
        await this.handleVideoUpload(file);
      }
    });
  }

  private async handleVideoUpload(file: File): Promise<void> {
    if (!file.type.startsWith('video/') || this.isVideoUploading) return;

    this.isVideoUploading = true;
    this.videoMimeType = file.type;
    this.refreshUploadZone();

    try {
      // Detect dimensions from file before upload
      const dimensions = await this.detectVideoDimensions(file);
      if (dimensions) {
        this.videoDimensions = dimensions;
        this.detectedKind = dimensions.width >= dimensions.height ? 21 : 22;
        this.kindOverride = false;
      }

      if (!this.mediaApi) {
        ToastService.show('Media module not available', 'error');
        return;
      }

      const result = await this.mediaApi.uploadFile(file);

      if (result.success && result.url) {
        this.videoUrl = result.url;
        this.systemLogger.info('VideoEditorView', 'Video uploaded');
      } else {
        ToastService.show(result.error || 'Video upload failed', 'error');
      }
    } catch (error) {
      this.systemLogger.error('VideoEditorView', 'Video upload failed:', error);
    } finally {
      this.isVideoUploading = false;
      this.refreshUploadZone();
      this.updateButtonStates();
    }
  }

  private detectVideoDimensions(file: File): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';

      video.onloadedmetadata = () => {
        resolve({ width: video.videoWidth, height: video.videoHeight });
        URL.revokeObjectURL(video.src);
      };
      video.onerror = () => {
        resolve(null);
        URL.revokeObjectURL(video.src);
      };

      video.src = URL.createObjectURL(file);
    });
  }

  private refreshUploadZone(): void {
    const field = this.container.querySelector('.form__row:first-child');
    if (!field) return;

    const label = field.querySelector('label');
    const oldZone = field.querySelector('.video-editor__upload-zone, .video-editor__preview');
    if (oldZone) {
      const temp = document.createElement('div');
      temp.innerHTML = this.renderUploadZone();
      oldZone.replaceWith(temp.firstElementChild!);
    } else if (label) {
      label.insertAdjacentHTML('afterend', this.renderUploadZone());
    }

    // Re-attach upload listeners if the upload zone is showing (no video, not uploading)
    if (!this.videoUrl && !this.isVideoUploading) {
      this.setupVideoUpload();
    }
  }

  private setupThumbnailUpload(): void {
    const uploadBtn = this.container.querySelector('[data-action="upload-thumbnail"]');
    const fileInput = this.container.querySelector('[data-thumb-file]') as HTMLInputElement;

    uploadBtn?.addEventListener('click', () => {
      if (!this.isThumbnailUploading) {
        fileInput?.click();
      }
    });

    fileInput?.addEventListener('change', async (e) => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      if (file) {
        await this.handleThumbnailUpload(file);
        target.value = '';
      }
    });
  }

  private async handleThumbnailUpload(file: File): Promise<void> {
    if (!file.type.startsWith('image/') || this.isThumbnailUploading) return;

    this.isThumbnailUploading = true;
    const uploadBtn = this.container.querySelector('[data-action="upload-thumbnail"]') as HTMLButtonElement;
    const thumbInput = this.container.querySelector('[data-field="thumbnailUrl"]') as HTMLInputElement;

    if (uploadBtn) {
      uploadBtn.innerHTML = `
        <svg class="spin" width="18" height="18"><use href="#icon-spin-loader"/></svg>
      `;
      uploadBtn.disabled = true;
    }

    try {
      if (!this.mediaApi) return;

      const result = await this.mediaApi.uploadFile(file);

      if (result.success && result.url) {
        this.thumbnailUrl = result.url;
        if (thumbInput) {
          thumbInput.value = result.url;
        }
        this.systemLogger.info('VideoEditorView', 'Thumbnail uploaded');
      }
    } catch (error) {
      this.systemLogger.error('VideoEditorView', 'Thumbnail upload failed:', error);
    } finally {
      this.isThumbnailUploading = false;
      if (uploadBtn) {
        uploadBtn.innerHTML = `
          <svg width="18" height="18"><use href="#icon-upload"/></svg>
        `;
        uploadBtn.disabled = false;
      }
    }
  }

  private handleToggleKind(): void {
    this.kindOverride = true;
    this.detectedKind = this.detectedKind === 21 ? 22 : 21;

    const badge = this.container.querySelector('.video-editor__kind-badge');
    if (badge) {
      badge.setAttribute('data-kind', String(this.detectedKind));
      badge.textContent = `${this.detectedKind === 21 ? 'Landscape' : 'Portrait'} (Kind ${this.detectedKind})`;
    }
  }

  private handleRemoveVideo(): void {
    this.videoUrl = '';
    this.videoMimeType = '';
    this.videoDimensions = null;
    this.detectedKind = 21;
    this.kindOverride = false;
    this.refreshUploadZone();
    this.updateButtonStates();
  }

  private insertAtCursor(text: string): void {
    const textarea = this.container.querySelector('.video-editor-description') as HTMLTextAreaElement;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const before = this.content.slice(0, start);
    const after = this.content.slice(textarea.selectionEnd);

    this.content = before + text + after;
    textarea.value = this.content;

    const newPos = start + text.length;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();
  }

  private updateButtonStates(): void {
    const hasVideo = this.videoUrl.length > 0;
    const hasRelays = this.selectedRelays.size > 0;
    const isValid = hasVideo && hasRelays;

    const publishBtn = this.container.querySelector('[data-action="publish"]') as HTMLButtonElement;
    if (publishBtn) {
      publishBtn.disabled = !isValid || this.isPublishing;
    }
  }

  private async handlePublish(): Promise<void> {
    if (!AuthGuard.requireAuth('publish a video')) return;
    if (this.isPublishing || !this.videoUrl) return;

    this.isPublishing = true;
    this.updateButtonStates();

    const btn = this.container.querySelector('[data-action="publish"]') as HTMLButtonElement;
    const originalText = btn?.textContent || '';
    if (btn) {
      btn.textContent = 'Publishing...';
    }

    try {
      const topics = this.tags.split(',').map(t => t.trim()).filter(Boolean);

      const videoData: VideoOptions = {
        videoUrl: this.videoUrl,
        mimeType: this.videoMimeType || 'video/mp4',
        content: this.content,
        relays: Array.from(this.selectedRelays)
      };

      if (this.videoDimensions) videoData.dimensions = this.videoDimensions;
      if (this.thumbnailUrl) videoData.thumbnailUrl = this.thumbnailUrl;
      if (this.title) videoData.title = this.title;
      if (topics.length > 0) videoData.topics = topics;
      if (this.kindOverride) videoData.kindOverride = this.detectedKind;

      const nevent = await this.mediaApi?.publishVideo(videoData) ?? null;

      if (nevent) {
        this.router.navigate('/');
      }
    } finally {
      this.isPublishing = false;
      if (btn) {
        btn.textContent = originalText;
      }
      this.updateButtonStates();
    }
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.relaySelector) {
      this.relaySelector.destroy();
      this.relaySelector = null;
    }
    if (this.toolbar) {
      this.toolbar.destroy();
      this.toolbar = null;
    }
    this.container.innerHTML = '';
  }
}
