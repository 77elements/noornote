/**
 * ArticleEditorView Component
 * Full-page editor for creating and publishing long-form articles (NIP-23)
 *
 * Features:
 * - Edit/Preview tabs
 * - Markdown content with preview
 * - Markdown formatting toolbar (bold, italic, heading, quote, image)
 * - Cover image upload + URL input
 * - Media upload & emoji picker (via PostEditorToolbar)
 * - Relay selector
 * - Save as Draft (kind 30024) or Publish (kind 30023)
 * - Unsaved changes confirmation on back navigation and tab close
 */

import { View } from './View';
import { Router } from '../../services/Router';
// ArticleService accessed via articles module API
import { RelayConfig } from '../../services/RelayConfig';
import { AuthGuard } from '../../services/AuthGuard';
import { loadEditorRelayConfig } from '../../helpers/editorRelayConfig';
import { insertTextAtCursor } from '../../helpers/insertTextAtCursor';
import { ProfileCarouselOrchestrator } from '../../services/orchestration/ProfileCarouselOrchestrator';
import { SystemLogger } from '../../services/SystemLogger';
import { RelaySelector } from '../post/RelaySelector';
import { PostEditorToolbar } from '../post/PostEditorToolbar';
import { setupPasteUpload } from '../../helpers/pasteUpload';
import { MentionAutocomplete } from '../mentions/MentionAutocomplete';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { MediaModuleApi } from '../../modules/media/contracts';
import type {
  ArticlesModuleApi,
  ArticleOptions,
} from '../../modules/articles/contracts';
import { ModalService } from '../../services/ModalService';
import { marked } from 'marked';
import { setupTabClickHandlers, switchTab } from '../../helpers/TabsHelper';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { FullscreenOverlay } from '../ui/FullscreenOverlay';
import { MarkdownToolbar } from '../ui/MarkdownToolbar';
import { npubToUsername } from '../../helpers/npubToUsername';
import {
  upgradeInlineMentions,
  setupUserMentionHandlers,
} from '../../helpers/UserMentionHelper';
import { upgradeArticleImages } from '../../helpers/upgradeArticleImages';
import { extractQuotedReferences } from '../../helpers/extractQuotedReferences';
import {
  formatQuotedReferences,
  type QuotedReference,
} from '../../helpers/formatQuotedReferences';
import { unwrapSolitaryParagraph } from '../../helpers/unwrapSolitaryParagraph';
import { processFootnotes } from '../../helpers/processFootnotes';
import { sanitizeArticleHtml } from '../../helpers/sanitizeUserHtml';
import { ContentProcessor } from '../../services/ContentProcessor';
import { QuotedNoteRenderer } from '../ui/note-rendering/QuotedNoteRenderer';
import { ArticlePreviewRenderer } from '../ui/note-rendering/ArticlePreviewRenderer';
import { isScheduledPostsEnabled } from '../../addons/scheduled-posts/index';

type TabMode = 'edit' | 'preview';

interface EditorSnapshot {
  title: string;
  content: string;
  summary: string;
  image: string;
  tags: string;
  publishedAt: number | null;
}

export class ArticleEditorView extends View {
  private container: HTMLElement;
  private router: Router;
  private _articlesApi?: ArticlesModuleApi | null;
  private get articlesApi(): ArticlesModuleApi | null {
    return (this._articlesApi ??=
      ModuleLoader.getInstance().getApi<ArticlesModuleApi>('articles'));
  }
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;
  private _mediaApi?: MediaModuleApi | null;
  private get mediaApi(): MediaModuleApi | null {
    return (this._mediaApi ??=
      ModuleLoader.getInstance().getApi<MediaModuleApi>('media'));
  }

  // Sub-components
  private relaySelector: RelaySelector | null = null;
  private toolbar: PostEditorToolbar | null = null;
  private mentionAutocomplete: MentionAutocomplete | null = null;

  // State
  private currentTab: TabMode = 'edit';
  private title: string = '';
  private content: string = '';
  private summary: string = '';
  private image: string = '';
  private tags: string = '';
  private identifier: string = '';
  private selectedRelays: Set<string> = new Set();
  private availableRelays: string[] = [];
  private isTestMode: boolean = false;
  private isPublishing: boolean = false;
  private isCoverUploading: boolean = false;
  private isEditMode: boolean = false;
  private isDraftMode: boolean = false;
  private editPubkey: string = '';
  private publishedAt: number | null = null;
  private fullscreenOverlay: FullscreenOverlay | null = null;
  private previewQuotedRefs: QuotedReference[] = [];

  // Shared Markdown formatting toolbar (main editor + focus mode)
  private readonly mdToolbar: MarkdownToolbar;
  private focusMdToolbar: MarkdownToolbar | null = null;

  // Dirty-state tracking
  private snapshot: EditorSnapshot = {
    title: '',
    content: '',
    summary: '',
    image: '',
    tags: '',
    publishedAt: null,
  };
  private beforeUnloadHandler = (e: BeforeUnloadEvent): void => {
    if (this.isDirty()) {
      e.preventDefault();
    }
  };

  constructor(editNaddr?: string) {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--article-editor';
    this.router = Router.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();

    // Main-editor Markdown toolbar — operates on the content textarea; the
    // existing input listener keeps this.content + button states in sync.
    this.mdToolbar = new MarkdownToolbar({
      getTextarea: () =>
        this.container.querySelector(
          '.article-editor-content'
        ) as HTMLTextAreaElement | null,
      onImageUpload: file => this.uploadContentImage(file),
    });

    // Generate initial identifier
    this.identifier = this.articlesApi?.generateIdentifier() ?? '';

    this.loadRelayConfiguration();

    if (editNaddr) {
      this.isEditMode = true;
      void this.loadExistingArticle(editNaddr);
    } else {
      this.render();
    }
  }

  /**
   * Load existing article for editing
   */
  private async loadExistingArticle(naddr: string): Promise<void> {
    // Show loading state
    this.container.innerHTML = `
      <div class="article-view-loading">
        <div class="loading-spinner"></div>
        <p>Loading article...</p>
      </div>
    `;

    try {
      this.systemLogger.info(
        'ArticleEditorView',
        `Loading article: ${naddr.slice(0, 30)}...`
      );
      const event =
        (await this.articlesApi?.fetchAddressableEvent(naddr)) ?? null;

      if (!event) {
        this.systemLogger.error(
          'ArticleEditorView',
          'Article not found on relays'
        );
        this.container.innerHTML = `<div class="article-view-error"><p>Article not found</p></div>`;
        return;
      }

      // Extract metadata and pre-fill fields
      const metadata = this.articlesApi?.extractArticleMetadata(event) ?? {
        title: '',
        image: '',
        summary: '',
        publishedAt: 0,
        identifier: '',
        topics: [],
      };
      this.title = metadata.title;
      this.content = event.content;
      this.summary = metadata.summary;
      this.image = metadata.image;
      this.identifier = metadata.identifier;
      this.tags = metadata.topics.join(', ');
      this.publishedAt = metadata.publishedAt;
      this.isDraftMode = event.kind === 30024;
      this.editPubkey = event.pubkey;

      this.systemLogger.info(
        'ArticleEditorView',
        `Article loaded: "${metadata.title}"`
      );
      this.render();
    } catch (error) {
      this.systemLogger.error(
        'ArticleEditorView',
        `Failed to load article: ${String(error)}`
      );
      this.container.innerHTML = `<div class="article-view-error"><p>Failed to load article</p></div>`;
    }
  }

  /**
   * Load relay configuration
   */
  private loadRelayConfiguration(): void {
    const cfg = loadEditorRelayConfig(this.relayConfig);
    this.isTestMode = cfg.isTestMode;
    this.availableRelays = cfg.availableRelays;
    this.selectedRelays = cfg.selectedRelays;
  }

  /**
   * Save a snapshot of the current editor state for dirty-checking
   */
  private saveSnapshot(): void {
    this.snapshot = {
      title: this.title,
      content: this.content,
      summary: this.summary,
      image: this.image,
      tags: this.tags,
      publishedAt: this.publishedAt,
    };
  }

  /**
   * Check if the editor has unsaved changes compared to the snapshot
   */
  private isDirty(): boolean {
    return (
      this.title !== this.snapshot.title ||
      this.content !== this.snapshot.content ||
      this.summary !== this.snapshot.summary ||
      this.image !== this.snapshot.image ||
      this.tags !== this.snapshot.tags ||
      this.publishedAt !== this.snapshot.publishedAt
    );
  }

  /**
   * Render the editor view
   */
  private render(): void {
    // Create relay selector
    this.relaySelector = new RelaySelector({
      availableRelays: this.availableRelays,
      selectedRelays: this.selectedRelays,
      isTestMode: this.isTestMode,
      onChange: selectedRelays => {
        this.selectedRelays = selectedRelays;
        this.updateButtonStates();
      },
    });

    // Create toolbar (no poll button for articles)
    this.toolbar = new PostEditorToolbar({
      onMediaUploaded: url => this.handleMediaUploaded(url),
      onEmojiSelected: emoji => this.handleEmojiSelected(emoji),
      textareaSelector: '.article-editor-content',
      showPoll: false,
    });

    this.container.innerHTML = `
      <div class="article-editor">
        <header class="l-spread">
          <h1>${this.isEditMode ? 'Edit Article' : 'Write Article'}</h1>
          <button class="btn btn--passive btn--medium" data-action="back">Back</button>
        </header>

        <div class="article-editor__toolbar">
          <div class="tabs">
            <button class="tab tab--active" data-tab="edit">Edit</button>
            <button class="tab" data-tab="preview">Preview</button>
          </div>
          <button class="btn btn--passive btn--medium" data-action="enter-focus" title="Distraction-free writing (Esc to exit)">Focus mode</button>
          ${this.relaySelector.render()}
        </div>

        <div class="article-editor__body section">
          ${this.renderEditMode()}
        </div>

        <footer class="article-editor__footer">
          ${this.toolbar.render()}
          <div class="article-editor__actions">
            ${this.isDraftMode ? '<button class="btn btn--danger btn--medium" data-action="delete-draft">Delete Draft</button>' : ''}
            <button class="btn btn--passive" data-action="save-draft">Save Draft <span class="form__note">(beta)</span></button>
            ${isScheduledPostsEnabled() ? '<button class="btn btn--passive" data-action="schedule-publish">Schedule Publish</button>' : ''}
            <button class="btn" data-action="publish">${this.isEditMode ? 'Update' : 'Publish'}</button>
          </div>
        </footer>
      </div>
    `;

    this.setupEventListeners();
    this.saveSnapshot();
  }

  /**
   * Render Markdown formatting toolbar
   */
  /**
   * Render edit mode content
   */
  private renderEditMode(): string {
    return `
      <div class="article-editor__form">
        <div class="form__row">
          <label for="article-title">Title</label>
          <input
            type="text"
            id="article-title"
            class="input input--title"
            placeholder="Article title..."
            value="${escapeHtml(this.title)}"
            data-field="title"
          />
        </div>

        <div class="form__row">
          <label for="article-content">Content (Markdown)</label>
          ${this.mdToolbar.render()}
          <textarea
            id="article-content"
            class="textarea textarea--code textarea--large article-editor-content"
            placeholder="Write your article in Markdown..."
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
              <label for="article-image">Cover Image</label>
              <div class="article-editor__cover-input">
                <input
                  type="text"
                  id="article-image"
                  class="input"
                  placeholder="https://... or upload"
                  value="${escapeHtml(this.image)}"
                  data-field="image"
                />
                <button type="button" class="article-editor__upload-btn" data-action="upload-cover" title="Upload image">
                  <svg width="18" height="18"><use href="#icon-upload"/></svg>
                </button>
                <input type="file" accept="image/*" class="article-editor__cover-file" data-cover-file style="display: none;" />
              </div>
            </div>

            <div class="form__row">
              <label for="article-summary">Summary</label>
              <textarea
                id="article-summary"
                class="textarea textarea--small"
                placeholder="Brief description of your article..."
                data-field="summary"
              >${escapeHtml(this.summary)}</textarea>
            </div>

            <div class="form__row">
              <label for="article-tags">Tags</label>
              <input
                type="text"
                id="article-tags"
                class="input"
                placeholder="nostr, bitcoin, technology (comma separated)"
                value="${escapeHtml(this.tags)}"
                data-field="tags"
              />
            </div>

            <div class="form__row">
              <label>
                Published at
                <span class="form__note">(set a past date for older articles you're re-publishing)</span>
              </label>
              <div class="l-spread">
                <span data-published-at-label>${this.renderPublishedAtLabel()}</span>
                <div>
                  <button type="button" class="btn btn--passive btn--medium" data-action="pick-published-at">Pick date</button>
                  ${this.publishedAt ? '<button type="button" class="btn btn--passive btn--medium" data-action="clear-published-at">Reset</button>' : ''}
                </div>
              </div>
            </div>

            <div class="form__row">
              <label for="article-identifier">
                Slug / Identifier
                <span class="form__note">(auto-generated, change only if you know what you're doing)</span>
              </label>
              <input
                type="text"
                id="article-identifier"
                class="input"
                placeholder="my-article-slug"
                value="${escapeHtml(this.identifier)}"
                data-field="identifier"
                title="Unique identifier for this article. Changing this after publishing creates a new article instead of updating."
              />
            </div>
          </div>
        </section>
      </div>
    `;
  }

  private renderPublishedAtLabel(): string {
    if (!this.publishedAt) return '<em>Now (on publish)</em>';
    const date = new Date(this.publishedAt * 1000);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  private refreshPublishedAtUI(): void {
    const label = this.container.querySelector('[data-published-at-label]');
    if (label) label.innerHTML = this.renderPublishedAtLabel();
    // Re-render the whole row's actions so the Reset button toggles correctly
    const row = this.container.querySelector(
      '[data-action="pick-published-at"]'
    )?.parentElement;
    if (row) {
      const hasReset = !!row.querySelector(
        '[data-action="clear-published-at"]'
      );
      if (this.publishedAt && !hasReset) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--passive btn--medium';
        btn.dataset.action = 'clear-published-at';
        btn.textContent = 'Reset';
        btn.addEventListener('click', () => this.handleClearPublishedAt());
        row.appendChild(btn);
      } else if (!this.publishedAt && hasReset) {
        row.querySelector('[data-action="clear-published-at"]')?.remove();
      }
    }
  }

  private async handlePickPublishedAt(): Promise<void> {
    const { pickDate } = await import('../../helpers/datePickerModal');
    const picked = await pickDate({
      title: 'Published at',
      initial: this.publishedAt
        ? new Date(this.publishedAt * 1000)
        : new Date(),
      max: new Date(),
      confirmLabel: 'Set date',
    });
    if (!picked) return;
    this.publishedAt = Math.floor(picked.getTime() / 1000);
    this.refreshPublishedAtUI();
    this.updateButtonStates();
  }

  private handleClearPublishedAt(): void {
    this.publishedAt = null;
    this.refreshPublishedAtUI();
    this.updateButtonStates();
  }

  /**
   * Render preview mode content
   */
  private renderPreviewMode(): string {
    const htmlContent = this.renderMarkdownContent(this.content);

    return `
      <div class="article-editor__preview">
        ${this.image ? `<img src="${escapeHtmlAttr(this.image)}" alt="${escapeHtml(this.title)}" class="article-editor__preview-image" />` : ''}
        <h1 class="article-editor__preview-title">${escapeHtml(this.title) || 'Untitled'}</h1>
        ${this.summary ? `<p class="article-editor__preview-summary">${escapeHtml(this.summary)}</p>` : ''}
        <div class="article-editor__preview-content">${htmlContent}</div>
        ${
          this.tags
            ? `
          <div class="article-editor__preview-tags">
            ${this.tags
              .split(',')
              .map(
                tag =>
                  `<span class="article-editor__preview-tag">#${escapeHtml(tag.trim())}</span>`
              )
              .join('')}
          </div>
        `
            : ''
        }
      </div>
    `;
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Back button
    const backBtn = this.container.querySelector('[data-action="back"]');
    backBtn?.addEventListener('click', () => this.handleBack());

    // Tab switching
    setupTabClickHandlers(this.container, tabId =>
      this.switchTab(tabId as TabMode)
    );

    // Field inputs
    this.setupFieldListeners();

    // Accordion toggle
    this.container.querySelectorAll('.nn-ui-toggle__header').forEach(header => {
      header.addEventListener('click', () =>
        header.closest('.nn-ui-toggle')?.classList.toggle('open')
      );
    });

    // Relay selector
    const relaySelectorContainer = this.container.querySelector(
      '.post-note-relay-selector'
    );
    if (this.relaySelector && relaySelectorContainer) {
      this.relaySelector.setupEventListeners(
        relaySelectorContainer as HTMLElement
      );
    }

    // Footer Toolbar (emoji, media for footer)
    const toolbarContainer = this.container.querySelector('.post-note-toolbar');
    if (this.toolbar && toolbarContainer) {
      this.toolbar.setupEventListeners(toolbarContainer as HTMLElement);
    }

    // Paste-to-upload into the article body.
    const pasteTarget = this.container.querySelector(
      '.article-editor-content'
    ) as HTMLElement | null;
    if (pasteTarget)
      setupPasteUpload(
        pasteTarget,
        files => void this.toolbar?.handleFileUpload(files)
      );

    // Markdown toolbar
    this.setupMarkdownToolbar();

    // Cover image upload
    this.setupCoverUpload();

    // Mention autocomplete
    this.mentionAutocomplete = new MentionAutocomplete({
      textareaSelector: '.article-editor-content',
      onMentionInserted: (_npub, username) => {
        this.systemLogger.info(
          'ArticleEditorView',
          `Mention inserted: @${username}`
        );
      },
    });
    this.mentionAutocomplete.init();

    // Action buttons
    const saveDraftBtn = this.container.querySelector(
      '[data-action="save-draft"]'
    );
    saveDraftBtn?.addEventListener('click', () => this.handleSaveDraft());

    const publishBtn = this.container.querySelector('[data-action="publish"]');
    publishBtn?.addEventListener('click', () => this.handlePublish());

    const schedulePublishBtn = this.container.querySelector(
      '[data-action="schedule-publish"]'
    );
    schedulePublishBtn?.addEventListener('click', () =>
      this.handleSchedulePublish()
    );

    const deleteDraftBtn = this.container.querySelector(
      '[data-action="delete-draft"]'
    );
    deleteDraftBtn?.addEventListener('click', () => this.handleDeleteDraft());

    const focusBtn = this.container.querySelector(
      '[data-action="enter-focus"]'
    );
    focusBtn?.addEventListener('click', () => this.enterFocusMode());

    const pickPublishedAtBtn = this.container.querySelector(
      '[data-action="pick-published-at"]'
    );
    pickPublishedAtBtn?.addEventListener('click', () =>
      this.handlePickPublishedAt()
    );
    const clearPublishedAtBtn = this.container.querySelector(
      '[data-action="clear-published-at"]'
    );
    clearPublishedAtBtn?.addEventListener('click', () =>
      this.handleClearPublishedAt()
    );

    // Auto-generate slug from title (only for new articles, not when editing)
    if (!this.isEditMode) {
      const titleInput = this.container.querySelector(
        '[data-field="title"]'
      ) as HTMLInputElement;
      titleInput?.addEventListener('blur', () => {
        if (this.title && !this.identifier.includes('-')) {
          // Only auto-generate if identifier hasn't been customized
          this.identifier =
            this.articlesApi?.generateIdentifier(this.title) ?? '';
          const identifierInput = this.container.querySelector(
            '[data-field="identifier"]'
          ) as HTMLInputElement;
          if (identifierInput) {
            identifierInput.value = this.identifier;
          }
        }
      });
    }

    // Unsaved changes: warn on browser tab close / reload
    window.addEventListener('beforeunload', this.beforeUnloadHandler);
  }

  /**
   * Setup Markdown toolbar event listeners
   */
  private setupMarkdownToolbar(): void {
    const root = this.container.querySelector(
      '.md-toolbar'
    ) as HTMLElement | null;
    if (root) this.mdToolbar.attach(root);
  }

  /**
   * Upload an image for the Markdown toolbar, returning its URL (or null).
   * Shared by the main editor and focus-mode toolbars.
   */
  private async uploadContentImage(file: File): Promise<string | null> {
    try {
      if (!this.mediaApi) return null;
      const result = await this.mediaApi.uploadFile(file);
      if (result.success && result.url) {
        this.systemLogger.info(
          'ArticleEditorView',
          'Image uploaded and inserted'
        );
        return result.url;
      }
    } catch (_error) {
      this.systemLogger.error(
        'ArticleEditorView',
        'Image upload failed:',
        _error
      );
    }
    return null;
  }

  /**
   * Setup cover image upload
   */
  private setupCoverUpload(): void {
    const uploadBtn = this.container.querySelector(
      '[data-action="upload-cover"]'
    );
    const fileInput = this.container.querySelector(
      '[data-cover-file]'
    ) as HTMLInputElement;

    uploadBtn?.addEventListener('click', () => {
      if (!this.isCoverUploading) {
        fileInput?.click();
      }
    });

    fileInput?.addEventListener('change', async e => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      if (file) {
        await this.handleCoverUpload(file);
        target.value = '';
      }
    });
  }

  /**
   * Handle cover image upload
   */
  private async handleCoverUpload(file: File): Promise<void> {
    if (!file.type.startsWith('image/') || this.isCoverUploading) return;

    this.isCoverUploading = true;
    const uploadBtn = this.container.querySelector(
      '[data-action="upload-cover"]'
    ) as HTMLButtonElement;
    const imageInput = this.container.querySelector(
      '[data-field="image"]'
    ) as HTMLInputElement;

    // Show loading state
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
        this.image = result.url;
        if (imageInput) {
          imageInput.value = result.url;
        }
        this.systemLogger.info('ArticleEditorView', 'Cover image uploaded');
      }
    } catch (_error) {
      this.systemLogger.error(
        'ArticleEditorView',
        'Cover upload failed:',
        _error
      );
    } finally {
      this.isCoverUploading = false;
      if (uploadBtn) {
        uploadBtn.innerHTML = `
          <svg width="18" height="18"><use href="#icon-upload"/></svg>
        `;
        uploadBtn.disabled = false;
      }
    }
  }

  /**
   * Setup field input listeners
   */
  private setupFieldListeners(): void {
    const fields = this.container.querySelectorAll('[data-field]');
    fields.forEach(field => {
      field.addEventListener('input', e => {
        const target = e.target as HTMLInputElement | HTMLTextAreaElement;
        const fieldName = target.dataset.field;

        if (fieldName === 'title') this.title = target.value;
        else if (fieldName === 'content') this.content = target.value;
        else if (fieldName === 'summary') this.summary = target.value;
        else if (fieldName === 'image') this.image = target.value;
        else if (fieldName === 'tags') this.tags = target.value;
        else if (fieldName === 'identifier') this.identifier = target.value;

        this.updateButtonStates();
      });
    });
  }

  /**
   * Switch between edit/preview tabs
   */
  private switchTab(tab: TabMode): void {
    if (tab === this.currentTab) return;

    this.currentTab = tab;

    // Update tab buttons
    switchTab(this.container, tab);

    // Update body content
    const body = this.container.querySelector('.article-editor__body');
    if (body) {
      if (tab === 'edit') {
        body.innerHTML = this.renderEditMode();
        this.setupFieldListeners();
        this.setupMarkdownToolbar();
        this.setupCoverUpload();

        // Re-init mention autocomplete
        if (this.mentionAutocomplete) {
          this.mentionAutocomplete.destroy();
        }
        this.mentionAutocomplete = new MentionAutocomplete({
          textareaSelector: '.article-editor-content',
          onMentionInserted: (_npub, _username) => {},
        });
        this.mentionAutocomplete.init();
      } else {
        body.innerHTML = this.renderPreviewMode();
        const previewContent = body.querySelector<HTMLElement>(
          '.article-editor__preview-content'
        );
        if (previewContent) {
          upgradeInlineMentions(previewContent);
          setupUserMentionHandlers(previewContent);
          upgradeArticleImages(previewContent);
          this.hydratePreviewQuotes(previewContent);
        }
      }
    }
  }

  /**
   * Update button states based on form validity
   */
  private updateButtonStates(): void {
    const hasTitle = this.title.trim().length > 0;
    const hasContent = this.content.trim().length > 0;
    const hasRelays = this.selectedRelays.size > 0;
    const isValid = hasTitle && hasContent && hasRelays;

    const publishBtn = this.container.querySelector(
      '[data-action="publish"]'
    ) as HTMLButtonElement;
    const saveDraftBtn = this.container.querySelector(
      '[data-action="save-draft"]'
    ) as HTMLButtonElement;

    if (publishBtn) {
      publishBtn.disabled = !isValid || this.isPublishing;
    }
    if (saveDraftBtn) {
      saveDraftBtn.disabled = !isValid || this.isPublishing;
    }
  }

  /**
   * Handle back navigation with unsaved changes confirmation
   */
  private async handleBack(): Promise<void> {
    if (!this.isDirty()) {
      this.router.back();
      return;
    }

    const discard = await ModalService.getInstance().confirm({
      title: 'Unsaved Changes',
      message: 'You have unsaved changes. Discard them?',
      confirmText: 'Discard',
      cancelText: 'Keep Editing',
      confirmDestructive: true,
    });

    if (discard) {
      this.router.back();
    }
  }

  /**
   * Insert text at the current cursor position in the content textarea
   */
  private insertAtCursor(text: string): void {
    const textarea = this.container.querySelector(
      '.article-editor-content'
    ) as HTMLTextAreaElement;
    if (!textarea) return;
    this.content = insertTextAtCursor(textarea, this.content, text);
    this.updateButtonStates();
  }

  /**
   * Handle media uploaded (from footer toolbar)
   */
  private handleMediaUploaded(url: string): void {
    const isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(url);
    const insertion = isImage ? `\n![](${url})\n` : `\n${url}\n`;
    this.insertAtCursor(insertion);
  }

  /**
   * Handle emoji selected
   */
  private handleEmojiSelected(emoji: string): void {
    this.insertAtCursor(emoji);
  }

  /**
   * Handle save draft
   */
  private async handleSaveDraft(): Promise<void> {
    if (!AuthGuard.requireAuth('save a draft')) return;

    await this.submitArticle(true);
  }

  /**
   * Handle publish
   */
  private async handlePublish(): Promise<void> {
    if (!AuthGuard.requireAuth('publish an article')) return;

    await this.submitArticle(false);
  }

  /**
   * Handle schedule publish — pick date/time, then hand the article off to
   * the scheduler addon. Only available when the Scheduled Posts addon is on.
   */
  private async handleSchedulePublish(): Promise<void> {
    if (!AuthGuard.requireAuth('schedule an article')) return;
    if (this.isPublishing) return;

    const { pickDateTime } = await import('../../helpers/datePickerModal');
    const picked = await pickDateTime({
      title: 'Schedule Article',
      initial: new Date(Date.now() + 60 * 60 * 1000),
      min: new Date(Date.now() + 60 * 1000),
      max: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      confirmLabel: 'Schedule',
    });
    if (!picked) return;

    const scheduledAt = Math.floor(picked.getTime() / 1000);

    this.isPublishing = true;
    this.updateButtonStates();
    const btn = this.container.querySelector(
      '[data-action="schedule-publish"]'
    ) as HTMLButtonElement;
    const originalText = btn?.textContent || '';
    if (btn) btn.textContent = 'Scheduling...';

    try {
      const topics = this.tags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);
      const { scheduleArticle } = await import(
        '../../addons/scheduled-posts/scheduleArticle'
      );

      const naddr = await scheduleArticle({
        title: this.title,
        content: this.content,
        identifier:
          this.identifier ||
          this.articlesApi?.generateIdentifier(this.title) ||
          '',
        relays: Array.from(this.selectedRelays),
        scheduledAt,
        ...(this.summary ? { summary: this.summary } : {}),
        ...(this.image ? { image: this.image } : {}),
        ...(topics.length > 0 ? { topics } : {}),
        ...(this.publishedAt ? { publishedAt: this.publishedAt } : {}),
      });

      if (naddr) {
        this.saveSnapshot();
        this.router.back();
      }
    } finally {
      this.isPublishing = false;
      if (btn) btn.textContent = originalText;
      this.updateButtonStates();
    }
  }

  /**
   * Handle delete draft via NIP-09
   */
  private async handleDeleteDraft(): Promise<void> {
    if (!AuthGuard.requireAuth('delete this draft')) return;

    const confirmed = await ModalService.getInstance().confirm({
      title: 'Delete Draft',
      message:
        'This will send a deletion request to all relays. This cannot be undone.',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      confirmDestructive: true,
    });

    if (!confirmed) return;

    const { ModuleLoader } = await import('../../core/ModuleLoader');
    const postsApi =
      ModuleLoader.getInstance().getApi<
        import('../../modules/posts/contracts').PostsModuleApi
      >('posts');
    const coordinate = `30024:${this.editPubkey}:${this.identifier}`;
    const deleted = await (postsApi?.deleteByCoordinates([coordinate]) ??
      Promise.resolve(false));

    if (deleted) {
      this.saveSnapshot(); // Prevent unsaved changes warning
      this.router.back();
    }
  }

  /**
   * Submit article (draft or publish)
   */
  private async submitArticle(isDraft: boolean): Promise<void> {
    if (this.isPublishing) return;

    this.isPublishing = true;
    this.updateButtonStates();

    const btn = this.container.querySelector(
      isDraft ? '[data-action="save-draft"]' : '[data-action="publish"]'
    ) as HTMLButtonElement;
    const originalText = btn?.textContent || '';
    if (btn) {
      btn.textContent = isDraft ? 'Saving...' : 'Publishing...';
    }

    try {
      const topics = this.tags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);

      const articleData: ArticleOptions = {
        title: this.title,
        content: this.content,
        identifier:
          this.identifier ||
          this.articlesApi?.generateIdentifier(this.title) ||
          '',
        relays: Array.from(this.selectedRelays),
      };

      // Only add optional properties if they have values (exactOptionalPropertyTypes)
      if (this.summary) articleData.summary = this.summary;
      if (this.image) articleData.image = this.image;
      if (topics.length > 0) articleData.topics = topics;
      if (this.publishedAt) articleData.publishedAt = this.publishedAt;

      const naddr = isDraft
        ? ((await this.articlesApi?.saveDraft(articleData)) ?? null)
        : ((await this.articlesApi?.publishArticle(articleData)) ?? null);

      // After successful save, update snapshot so dirty-check won't trigger
      this.saveSnapshot();

      // Refresh the author's profile carousel cache so the new article/draft
      // shows immediately instead of waiting out the orchestrator TTL.
      if (naddr)
        ProfileCarouselOrchestrator.getInstance().invalidateForCurrentUser();

      if (naddr && !isDraft) {
        this.router.navigate(`/article/${naddr}`);
      }
    } finally {
      this.isPublishing = false;
      if (btn) {
        btn.textContent = originalText;
      }
      this.updateButtonStates();
    }
  }

  /**
   * Render markdown content
   */
  private renderMarkdownContent(content: string): string {
    if (!content) {
      this.previewQuotedRefs = [];
      return '<p class="article-editor__preview-empty">No content yet...</p>';
    }

    try {
      marked.setOptions({
        breaks: true,
        gfm: true,
      });

      // Extract quoted nostr references before markdown parsing (NIP-27)
      const quotedReferences = extractQuotedReferences(
        content
      ) as QuotedReference[];
      this.previewQuotedRefs = quotedReferences;

      // Same pipeline as ArticleView.renderMarkdown: footnotes + sanitize with
      // the shared whitelist, so the preview shows exactly the published result.
      const { bodyMd, footnotesHtml } = processFootnotes(content);
      let html = sanitizeArticleHtml(
        (marked.parse(bodyMd) as string) + footnotesHtml
      );
      // Add rel for security - global handler in App.ts opens external links
      html = html.replace(/<a href=/g, '<a rel="noopener noreferrer" href=');

      if (quotedReferences.length > 0) {
        html = formatQuotedReferences(html, quotedReferences);
      }

      // Convert nostr:npub / nostr:nprofile mentions to profile links (same as ArticleView)
      const contentProcessor = ContentProcessor.getInstance();
      const profileResolver = (hexPubkey: string) => {
        const profile = contentProcessor.getNonBlockingProfile(hexPubkey);
        return profile
          ? {
              ...(profile.name !== undefined && { name: profile.name }),
              ...(profile.display_name !== undefined && {
                display_name: profile.display_name,
              }),
              ...(profile.picture !== undefined && {
                picture: profile.picture,
              }),
            }
          : null;
      };
      return npubToUsername(html, 'html-multi', profileResolver, {
        forceFullMode: true,
      });
    } catch (_err) {
      this.previewQuotedRefs = [];
      return `<p>${escapeHtml(content)}</p>`;
    }
  }

  /**
   * Replace quote-marker spans in the preview with actual quoted-note boxes.
   * Mirrors the hydration ArticleView does post-mount so Preview matches the
   * final render (including the collapsible Show More behavior).
   */
  private hydratePreviewQuotes(previewContent: HTMLElement): void {
    if (this.previewQuotedRefs.length === 0) return;

    const quotedNoteRenderer = QuotedNoteRenderer.getInstance();
    const articleRenderer = ArticlePreviewRenderer.getInstance();

    this.previewQuotedRefs.forEach(ref => {
      const marker = previewContent.querySelector(
        `.quote-marker[data-quote-ref="${CSS.escape(ref.fullMatch)}"]`
      );
      if (!marker) return;

      // Lift the marker out of a solitary <p> so the quote-box isn't block-in-<p>.
      unwrapSolitaryParagraph(marker);

      if (ref.type === 'addr') {
        articleRenderer.renderArticlePreview(
          ref.fullMatch,
          marker.parentElement!
        );
        marker.remove();
      } else {
        const skeleton = quotedNoteRenderer.createQuoteSkeleton();
        marker.replaceWith(skeleton);
        void quotedNoteRenderer.fetchAndRenderQuote(ref, skeleton, true);
      }
    });
  }

  /**
   * Get element
   */
  public getElement(): HTMLElement {
    return this.container;
  }

  private enterFocusMode(): void {
    if (this.fullscreenOverlay?.isMounted()) return;

    const body = document.createElement('div');
    body.className = 'article-editor-focus-body';

    // Focus-mode Markdown toolbar — same component, bound to the focus textarea.
    this.focusMdToolbar = new MarkdownToolbar({
      getTextarea: () =>
        body.querySelector(
          '[data-focus-field="content"]'
        ) as HTMLTextAreaElement | null,
      onImageUpload: file => this.uploadContentImage(file),
    });

    body.innerHTML = `
      <section class="section">
        <div class="form__row">
          <label for="focus-title">Title</label>
          <input type="text" id="focus-title" class="input input--title" placeholder="Article title..." data-focus-field="title" />
        </div>
        <div class="form__row">
          <label for="focus-content">Content (Markdown)</label>
          ${this.focusMdToolbar.render()}
          <textarea id="focus-content" class="textarea textarea--code textarea--large" placeholder="Write your article in Markdown..." data-focus-field="content"></textarea>
        </div>
      </section>
    `;

    const titleInput = body.querySelector(
      '[data-focus-field="title"]'
    ) as HTMLInputElement;
    const contentInput = body.querySelector(
      '[data-focus-field="content"]'
    ) as HTMLTextAreaElement;
    titleInput.value = this.title;
    contentInput.value = this.content;

    titleInput.addEventListener('input', () => {
      this.title = titleInput.value;
    });
    contentInput.addEventListener('input', () => {
      this.content = contentInput.value;
    });

    const focusToolbarRoot = body.querySelector(
      '.md-toolbar'
    ) as HTMLElement | null;
    if (focusToolbarRoot) this.focusMdToolbar.attach(focusToolbarRoot);

    this.fullscreenOverlay = new FullscreenOverlay({
      title: this.isEditMode ? 'Edit Article' : 'Write Article',
      exitLabel: 'Exit Focus Mode',
      body,
      onExit: () => {
        const realTitle = this.container.querySelector(
          '[data-field="title"]'
        ) as HTMLInputElement | null;
        const realContent = this.container.querySelector(
          '[data-field="content"]'
        ) as HTMLTextAreaElement | null;
        if (realTitle) {
          realTitle.value = this.title;
          realTitle.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (realContent) {
          realContent.value = this.content;
          realContent.dispatchEvent(new Event('input', { bubbles: true }));
        }
        this.focusMdToolbar?.destroy();
        this.focusMdToolbar = null;
        this.fullscreenOverlay = null;
      },
    });
    this.fullscreenOverlay.mount();
    contentInput.focus();
  }

  /**
   * Destroy view
   */
  public destroy(): void {
    window.removeEventListener('beforeunload', this.beforeUnloadHandler);
    this.mdToolbar.destroy();
    this.focusMdToolbar?.destroy();
    this.focusMdToolbar = null;
    if (this.fullscreenOverlay) {
      this.fullscreenOverlay.unmount();
      this.fullscreenOverlay = null;
    }
    if (this.relaySelector) {
      this.relaySelector.destroy();
      this.relaySelector = null;
    }
    if (this.toolbar) {
      this.toolbar.destroy();
      this.toolbar = null;
    }
    if (this.mentionAutocomplete) {
      this.mentionAutocomplete.destroy();
      this.mentionAutocomplete = null;
    }
    this.container.innerHTML = '';
  }
}
