/**
 * VideoEditorView Component
 * Full-page editor for creating and publishing media events:
 * videos (NIP-71, kind 21/22) and images (NIP-68, kind 20)
 *
 * Features:
 * - Video or image upload with drag & drop + click-to-upload
 * - Auto-detect landscape (Kind 21) / portrait (Kind 22) from dimensions
 * - Thumbnail upload
 * - Title, description, tags
 * - Emoji picker (via PostEditorToolbar)
 * - Relay selector
 */

import { View } from './View';
import { LazyModuleApi } from '../../core/LazyModuleApi';
import { _ } from '../../i18n';
import { Router } from '../../services/Router';

/** Optional exit seam: Focus UI (v2) closes the composer column instead of a classic router navigation. */
export interface VideoEditorViewOptions {
  /** Called on publish success (instead of router.navigate('/')). */
  onClose?: () => void;
}
import {
  type VideoOptions,
  type PictureOptions,
  type MediaModuleApi,
} from '../../modules/media/contracts';
import { RelayConfig } from '../../services/RelayConfig';
import { AuthGuard } from '../../services/AuthGuard';
import { loadEditorRelayConfig } from '../../helpers/editorRelayConfig';
import { insertTextAtCursor } from '../../helpers/insertTextAtCursor';
import { SystemLogger } from '../../services/SystemLogger';
import { RelaySelector } from '../post/RelaySelector';
import {
  setupEditorChrome,
  createEditorRelaySelector,
} from '../post/editorChrome';
import { PostEditorToolbar } from '../post/PostEditorToolbar';
import { setupPasteUpload } from '../../helpers/pasteUpload';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { ProfileModuleApi } from '../../modules/profile/contracts';
import { ToastService } from '../../services/ToastService';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';

type DetectedKind = 21 | 22;
/** What the user uploaded — videos publish kind 21/22, images kind 20. */
type MediaType = 'video' | 'image';

export class VideoEditorView extends View {
  private container: HTMLElement;
  private router: Router;
  private readonly onClose: (() => void) | null;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;
  private mediaApi = new LazyModuleApi<MediaModuleApi>('media');

  // Sub-components
  private relaySelector: RelaySelector | null = null;
  private toolbar: PostEditorToolbar | null = null;

  // State
  private mediaType: MediaType = 'video';
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

  constructor(options?: VideoEditorViewOptions) {
    super();
    this.onClose = options?.onClose ?? null;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--video-editor';
    this.router = Router.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();

    this.loadRelayConfiguration();
    this.render();
  }

  private loadRelayConfiguration(): void {
    const cfg = loadEditorRelayConfig(this.relayConfig);
    this.isTestMode = cfg.isTestMode;
    this.availableRelays = cfg.availableRelays;
    this.selectedRelays = cfg.selectedRelays;
  }

  private render(): void {
    this.relaySelector = createEditorRelaySelector({
      availableRelays: this.availableRelays,
      selectedRelays: this.selectedRelays,
      isTestMode: this.isTestMode,
      onChange: selectedRelays => {
        this.selectedRelays = selectedRelays;
        this.updateButtonStates();
      },
    });

    this.toolbar = new PostEditorToolbar({
      // The video itself is uploaded separately; toolbar/paste media is inserted
      // into the description text (e.g. a thumbnail or extra image URL).
      onMediaUploaded: url => this.insertAtCursor(url),
      onEmojiSelected: emoji => this.insertAtCursor(emoji),
      textareaSelector: '.video-editor-description',
      showPoll: false,
    });

    this.container.innerHTML = `
        <div class="back-padder focus-flow-root">
        <div class="video-editor">
          <header class="video-editor__header">
            <h1 class="video-editor__title">${_('Post Media')}</h1>
          </header>

          <div class="video-editor__toolbar">
            ${this.relaySelector.render()}
          </div>

          <div class="video-editor__body">
            ${this.renderForm()}
          </div>

          <footer class="video-editor__footer">
            ${this.toolbar.render()}
            <div class="video-editor__actions l-row--right">
              <button class="btn" data-action="publish" disabled>${_('Publish')}</button>
            </div>
          </footer>
        </div>
    
        </div>
    `;

    this.setupEventListeners();
  }

  private renderForm(): string {
    return `
      <div class="video-editor__form">
        <div class="form__row">
          <label>${_('Video or image')}</label>
          ${this.renderUploadZone()}
        </div>

        <div class="form__row">
          <label for="video-title">${_('Title')}</label>
          <input
            type="text"
            id="video-title"
            class="input"
            placeholder="${_('Title (optional)')}"
            value="${escapeHtml(this.title)}"
            data-field="title"
          />
        </div>

        <div class="form__row">
          <label for="video-description">${_('Description')}</label>
          <textarea
            id="video-description"
            class="textarea video-editor-description"
            placeholder="${_('Describe your media...')}"
            data-field="content"
          >${escapeHtml(this.content)}</textarea>
        </div>

        <section class="nn-ui-toggle">
          <div class="nn-ui-toggle__header">
            <div class="nn-ui-toggle__info">
              <h2 class="nn-ui-toggle__title">${_('Details')}</h2>
            </div>
            <button class="nn-ui-toggle__toggle" aria-label="${_('Toggle section')}">
              <svg width="24" height="24"><use href="#icon-chevron-down"/></svg>
            </button>
          </div>
          <div class="nn-ui-toggle__content">
            <div class="form__row">
              <label>${_('Thumbnail')}</label>
              <div class="video-editor__thumb-input">
                <input
                  type="text"
                  class="input"
                  placeholder="${_('https://... or upload')}"
                  value="${escapeHtml(this.thumbnailUrl)}"
                  data-field="thumbnailUrl"
                />
                <button type="button" class="video-editor__upload-btn" data-action="upload-thumbnail" title="${_('Upload thumbnail')}">
                  <svg width="18" height="18"><use href="#icon-upload"/></svg>
                </button>
                <input type="file" accept="image/*" class="video-editor__thumb-file" data-thumb-file style="display: none;" />
              </div>
            </div>

            <div class="form__row">
              <label for="video-tags">${_('Tags')}</label>
              <input
                type="text"
                id="video-tags"
                class="input"
                placeholder="${_('nostr, music, tutorial (comma separated)')}"
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
      if (this.mediaType === 'image') {
        return `
          <div class="video-editor__preview">
            <img
              class="video-editor__video"
              src="${escapeHtmlAttr(this.videoUrl)}"
              alt="${_('Uploaded image preview')}"
            />
            <div class="video-editor__video-info">
              ${this.videoDimensions ? `<span class="video-editor__dimensions">${this.videoDimensions.width}x${this.videoDimensions.height}</span>` : ''}
              <button type="button" class="video-editor__remove-video" data-action="remove-video" title="${_('Remove media')}">
                <svg width="16" height="16"><use href="#icon-close"/></svg>
              </button>
            </div>
          </div>
        `;
      }
      return `
        <div class="video-editor__preview">
          <video
            class="video-editor__video"
            src="${escapeHtmlAttr(this.videoUrl)}"
            controls
            preload="metadata"
          ></video>
          <div class="video-editor__video-info">
            <span class="video-editor__kind-badge" data-kind="${this.detectedKind}">
              ${this.detectedKind === 21 ? _('Landscape') : _('Portrait')} (Kind ${this.detectedKind})
            </span>
            ${this.videoDimensions ? `<span class="video-editor__dimensions">${this.videoDimensions.width}x${this.videoDimensions.height}</span>` : ''}
            <button type="button" class="video-editor__toggle-kind" data-action="toggle-kind" title="${_('Switch orientation')}">
              <svg width="16" height="16"><use href="#icon-switch-arrows"/></svg>
            </button>
            <button type="button" class="video-editor__remove-video" data-action="remove-video" title="${_('Remove media')}">
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
          <span>${_('Uploading media...')}</span>
        </div>
      `;
    }

    return `
      <div class="video-editor__upload-zone" data-action="upload-video">
        <svg width="32" height="32"><use href="#icon-video"/></svg>
        <span>${_('Click or drag & drop to upload video or image')}</span>
        <input type="file" accept="video/*,image/*" class="video-editor__video-file" data-video-file style="display: none;" />
      </div>
    `;
  }

  private setupEventListeners(): void {
    // Field inputs
    this.setupFieldListeners();

    // Accordion, relay selector, footer toolbar (shared editor chrome; no tabs)
    setupEditorChrome({
      container: this.container,
      relaySelector: this.relaySelector,
      toolbar: this.toolbar,
      onTabSwitch: () => {},
    });

    // Paste-to-upload into the video description.
    const pasteTarget = this.container.querySelector(
      '.video-editor-description'
    ) as HTMLElement | null;
    if (pasteTarget)
      setupPasteUpload(
        pasteTarget,
        files => void this.toolbar?.handleFileUpload(files)
      );

    // Video upload zone
    this.setupVideoUpload();

    // Thumbnail upload
    this.setupThumbnailUpload();

    // Publish button
    const publishBtn = this.container.querySelector('[data-action="publish"]');
    publishBtn?.addEventListener('click', () => this.handlePublish());

    // Kind toggle + remove video (delegated, since they appear after upload)
    this.container.addEventListener('click', e => {
      const target = e.target as HTMLElement;
      const action = target
        .closest('[data-action]')
        ?.getAttribute('data-action');
      if (action === 'toggle-kind') this.handleToggleKind();
      if (action === 'remove-video') this.handleRemoveVideo();
    });
  }

  private setupFieldListeners(): void {
    const fields = this.container.querySelectorAll('[data-field]');
    fields.forEach(field => {
      field.addEventListener('input', e => {
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
    const fileInput = this.container.querySelector(
      '[data-video-file]'
    ) as HTMLInputElement;
    if (!zone || !fileInput) return;

    // Click to upload
    zone.addEventListener('click', () => fileInput.click());

    // File selected
    fileInput.addEventListener('change', async e => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      if (file) {
        await this.handleMediaUpload(file);
        target.value = '';
      }
    });

    // Drag & drop
    zone.addEventListener('dragover', e => {
      e.preventDefault();
      zone.classList.add('video-editor__upload-zone--dragover');
    });
    zone.addEventListener('dragleave', () => {
      zone.classList.remove('video-editor__upload-zone--dragover');
    });
    zone.addEventListener('drop', async e => {
      e.preventDefault();
      zone.classList.remove('video-editor__upload-zone--dragover');
      const file = (e as DragEvent).dataTransfer?.files[0];
      if (file && this.isSupportedMediaFile(file)) {
        await this.handleMediaUpload(file);
      }
    });
  }

  private isSupportedMediaFile(file: File): boolean {
    return file.type.startsWith('video/') || file.type.startsWith('image/');
  }

  private async handleMediaUpload(file: File): Promise<void> {
    if (!this.isSupportedMediaFile(file) || this.isVideoUploading) return;

    this.isVideoUploading = true;
    this.mediaType = file.type.startsWith('image/') ? 'image' : 'video';
    this.videoMimeType = file.type;
    this.refreshUploadZone();

    try {
      // Detect dimensions from file before upload
      const dimensions =
        this.mediaType === 'image'
          ? await this.detectImageDimensions(file)
          : await this.detectVideoDimensions(file);
      if (dimensions) {
        this.videoDimensions = dimensions;
        if (this.mediaType === 'video') {
          this.detectedKind = dimensions.width >= dimensions.height ? 21 : 22;
          this.kindOverride = false;
        }
      }

      const mediaApi = this.mediaApi.get();
      if (!mediaApi) {
        ToastService.show(_('Media module not available'), 'error');
        return;
      }

      const result = await mediaApi.uploadFile(file);

      if (result.success && result.url) {
        this.videoUrl = result.url;
        this.systemLogger.info('VideoEditorView', 'Media uploaded');
      } else {
        ToastService.show(result.error || _('Media upload failed'), 'error');
      }
    } catch (error) {
      this.systemLogger.error('VideoEditorView', 'Media upload failed:', error);
    } finally {
      this.isVideoUploading = false;
      this.refreshUploadZone();
      this.updateButtonStates();
    }
  }

  private detectImageDimensions(
    file: File
  ): Promise<{ width: number; height: number } | null> {
    return new Promise(resolve => {
      const img = new Image();

      img.onload = () => {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => {
        resolve(null);
        URL.revokeObjectURL(img.src);
      };

      img.src = URL.createObjectURL(file);
    });
  }

  private detectVideoDimensions(
    file: File
  ): Promise<{ width: number; height: number } | null> {
    return new Promise(resolve => {
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
    const oldZone = field.querySelector(
      '.video-editor__upload-zone, .video-editor__preview'
    );
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
    const uploadBtn = this.container.querySelector(
      '[data-action="upload-thumbnail"]'
    );
    const fileInput = this.container.querySelector(
      '[data-thumb-file]'
    ) as HTMLInputElement;

    uploadBtn?.addEventListener('click', () => {
      if (!this.isThumbnailUploading) {
        fileInput?.click();
      }
    });

    fileInput?.addEventListener('change', async e => {
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
    const uploadBtn = this.container.querySelector(
      '[data-action="upload-thumbnail"]'
    ) as HTMLButtonElement;
    const thumbInput = this.container.querySelector(
      '[data-field="thumbnailUrl"]'
    ) as HTMLInputElement;

    if (uploadBtn) {
      uploadBtn.innerHTML = `
        <svg class="spin" width="18" height="18"><use href="#icon-spin-loader"/></svg>
      `;
      uploadBtn.disabled = true;
    }

    try {
      const mediaApi = this.mediaApi.get();
      if (!mediaApi) return;

      const result = await mediaApi.uploadFile(file);

      if (result.success && result.url) {
        this.thumbnailUrl = result.url;
        if (thumbInput) {
          thumbInput.value = result.url;
        }
        this.systemLogger.info('VideoEditorView', 'Thumbnail uploaded');
      }
    } catch (error) {
      this.systemLogger.error(
        'VideoEditorView',
        'Thumbnail upload failed:',
        error
      );
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
      badge.textContent = `${this.detectedKind === 21 ? _('Landscape') : _('Portrait')} (Kind ${this.detectedKind})`;
    }
  }

  private handleRemoveVideo(): void {
    this.mediaType = 'video';
    this.videoUrl = '';
    this.videoMimeType = '';
    this.videoDimensions = null;
    this.detectedKind = 21;
    this.kindOverride = false;
    this.refreshUploadZone();
    this.updateButtonStates();
  }

  private insertAtCursor(text: string): void {
    const textarea = this.container.querySelector(
      '.video-editor-description'
    ) as HTMLTextAreaElement;
    if (!textarea) return;
    this.content = insertTextAtCursor(textarea, this.content, text);
  }

  private updateButtonStates(): void {
    const hasVideo = this.videoUrl.length > 0;
    const hasRelays = this.selectedRelays.size > 0;
    const isValid = hasVideo && hasRelays;

    const publishBtn = this.container.querySelector(
      '[data-action="publish"]'
    ) as HTMLButtonElement;
    if (publishBtn) {
      publishBtn.disabled = !isValid || this.isPublishing;
    }
  }

  private async handlePublish(): Promise<void> {
    if (!AuthGuard.requireAuth('publish media')) return;
    if (this.isPublishing || !this.videoUrl) return;

    this.isPublishing = true;
    this.updateButtonStates();

    const btn = this.container.querySelector(
      '[data-action="publish"]'
    ) as HTMLButtonElement;
    const originalText = btn?.textContent || '';
    if (btn) {
      btn.textContent = _('Publishing...');
    }

    try {
      const topics = this.tags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);

      const nevent =
        this.mediaType === 'image'
          ? await this.publishPicture(topics)
          : await this.publishVideo(topics);

      if (nevent) {
        ModuleLoader.getInstance()
          .getApi<ProfileModuleApi>('profile')
          ?.invalidateCarouselCacheForCurrentUser();
        if (this.onClose) this.onClose();
        else this.router.navigate('/');
      }
    } finally {
      this.isPublishing = false;
      if (btn) {
        btn.textContent = originalText;
      }
      this.updateButtonStates();
    }
  }

  /** Publish the uploaded video (kind 21/22). */
  private async publishVideo(topics: string[]): Promise<string | null> {
    const videoData: VideoOptions = {
      videoUrl: this.videoUrl,
      mimeType: this.videoMimeType || 'video/mp4',
      content: this.content,
      relays: Array.from(this.selectedRelays),
    };

    if (this.videoDimensions) videoData.dimensions = this.videoDimensions;
    if (this.thumbnailUrl) videoData.thumbnailUrl = this.thumbnailUrl;
    if (this.title) videoData.title = this.title;
    if (topics.length > 0) videoData.topics = topics;
    if (this.kindOverride) videoData.kindOverride = this.detectedKind;

    return (await this.mediaApi.get()?.publishVideo(videoData)) ?? null;
  }

  /** Publish the uploaded image (kind 20, NIP-68). */
  private async publishPicture(topics: string[]): Promise<string | null> {
    const pictureData: PictureOptions = {
      imageUrl: this.videoUrl,
      mimeType: this.videoMimeType || 'image/jpeg',
      content: this.content,
      relays: Array.from(this.selectedRelays),
    };

    if (this.videoDimensions) pictureData.dimensions = this.videoDimensions;
    if (topics.length > 0) pictureData.topics = topics;

    return (await this.mediaApi.get()?.publishPicture(pictureData)) ?? null;
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
