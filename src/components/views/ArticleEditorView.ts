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
 */

import { View } from './View';
import { Router } from '../../services/Router';
import { ArticleService } from '../../services/ArticleService';
import { RelayConfig } from '../../services/RelayConfig';
import { AuthGuard } from '../../services/AuthGuard';
import { SystemLogger } from '../system/SystemLogger';
import { RelaySelector } from '../post/RelaySelector';
import { PostEditorToolbar } from '../post/PostEditorToolbar';
import { MentionAutocomplete } from '../mentions/MentionAutocomplete';
import { MediaUploadService } from '../../services/MediaUploadService';
import { marked } from 'marked';
import { setupTabClickHandlers, switchTab } from '../../helpers/TabsHelper';

type TabMode = 'edit' | 'preview';

export class ArticleEditorView extends View {
  private container: HTMLElement;
  private router: Router;
  private articleService: ArticleService;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;
  private mediaUploadService: MediaUploadService;

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

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'article-editor-view';
    this.router = Router.getInstance();
    this.articleService = ArticleService.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.mediaUploadService = MediaUploadService.getInstance();

    // Generate initial identifier
    this.identifier = ArticleService.generateIdentifier();

    this.loadRelayConfiguration();
    this.render();
  }

  /**
   * Load relay configuration
   */
  private loadRelayConfiguration(): void {
    const localRelaySettings = this.loadLocalRelaySettings();

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

  /**
   * Load local relay settings
   */
  private loadLocalRelaySettings(): { enabled: boolean; url: string } {
    try {
      const stored = localStorage.getItem('noornote_local_relay');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (_err) {
      // Ignore
    }
    return { enabled: false, url: 'ws://localhost:7777' };
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
      onChange: (selectedRelays) => {
        this.selectedRelays = selectedRelays;
        this.updateButtonStates();
      }
    });

    // Create toolbar (no poll button for articles)
    this.toolbar = new PostEditorToolbar({
      onMediaUploaded: (url) => this.handleMediaUploaded(url),
      onEmojiSelected: (emoji) => this.handleEmojiSelected(emoji),
      textareaSelector: '.article-editor-content',
      showPoll: false
    });

    this.container.innerHTML = `
      <div class="article-editor">
        <header class="article-editor__header">
          <button class="article-editor__back" data-action="back">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
            Back
          </button>
          <h1 class="article-editor__title">Write Article</h1>
        </header>

        <div class="article-editor__toolbar">
          <div class="tabs">
            <button class="tab tab--active" data-tab="edit">Edit</button>
            <button class="tab" data-tab="preview">Preview</button>
          </div>
          ${this.relaySelector.render()}
        </div>

        <div class="article-editor__body">
          ${this.renderEditMode()}
        </div>

        <footer class="article-editor__footer">
          ${this.toolbar.render()}
          <div class="article-editor__actions">
            <button class="btn btn--passive" data-action="save-draft">Save Draft</button>
            <button class="btn" data-action="publish">Publish</button>
          </div>
        </footer>
      </div>
    `;

    this.setupEventListeners();
  }

  /**
   * Render Markdown formatting toolbar
   */
  private renderMarkdownToolbar(): string {
    return `
      <div class="md-toolbar">
        <button type="button" class="btn-icon" data-md-action="heading" title="Heading">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <path d="M6 12h12M6 4v16M18 4v16"/>
          </svg>
        </button>
        <button type="button" class="btn-icon" data-md-action="bold" title="Bold">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/>
            <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/>
          </svg>
        </button>
        <button type="button" class="btn-icon" data-md-action="italic" title="Italic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <line x1="19" y1="4" x2="10" y2="4"/>
            <line x1="14" y1="20" x2="5" y2="20"/>
            <line x1="15" y1="4" x2="9" y2="20"/>
          </svg>
        </button>
        <button type="button" class="btn-icon" data-md-action="quote" title="Quote">
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
            <path d="M10 11H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v3a4 4 0 0 1-4 4H5"/>
            <path d="M19 11h-4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v3a4 4 0 0 1-4 4h-1"/>
          </svg>
        </button>
        <button type="button" class="btn-icon" data-md-action="image" title="Insert Image">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
        </button>
        <input type="file" accept="image/*" class="md-toolbar__file-input" data-md-file-input style="display: none;" />
      </div>
    `;
  }

  /**
   * Render edit mode content
   */
  private renderEditMode(): string {
    return `
      <div class="article-editor__form">
        <div class="article-editor__field">
          <label class="article-editor__label" for="article-title">Title</label>
          <input
            type="text"
            id="article-title"
            class="input input--title"
            placeholder="Article title..."
            value="${this.escapeHtml(this.title)}"
            data-field="title"
          />
        </div>

        <div class="article-editor__field">
          <label class="article-editor__label" for="article-content">Content (Markdown)</label>
          ${this.renderMarkdownToolbar()}
          <textarea
            id="article-content"
            class="textarea textarea--code textarea--large article-editor-content"
            placeholder="Write your article in Markdown..."
            data-field="content"
          >${this.escapeHtml(this.content)}</textarea>
        </div>

        <details class="article-editor__details" open>
          <summary class="article-editor__summary">Details</summary>
          <div class="article-editor__details-content">
            <div class="article-editor__field">
              <label class="article-editor__label">Cover Image</label>
              <div class="article-editor__cover-input">
                <input
                  type="text"
                  id="article-image"
                  class="input"
                  placeholder="https://... or upload"
                  value="${this.escapeHtml(this.image)}"
                  data-field="image"
                />
                <button type="button" class="article-editor__upload-btn" data-action="upload-cover" title="Upload image">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/>
                    <line x1="12" y1="3" x2="12" y2="15"/>
                  </svg>
                </button>
                <input type="file" accept="image/*" class="article-editor__cover-file" data-cover-file style="display: none;" />
              </div>
            </div>

            <div class="article-editor__field">
              <label class="article-editor__label" for="article-summary">Summary</label>
              <textarea
                id="article-summary"
                class="textarea textarea--small"
                placeholder="Brief description of your article..."
                data-field="summary"
              >${this.escapeHtml(this.summary)}</textarea>
            </div>

            <div class="article-editor__field">
              <label class="article-editor__label" for="article-tags">Tags</label>
              <input
                type="text"
                id="article-tags"
                class="input"
                placeholder="nostr, bitcoin, technology (comma separated)"
                value="${this.escapeHtml(this.tags)}"
                data-field="tags"
              />
            </div>

            <div class="article-editor__field">
              <label class="article-editor__label" for="article-identifier">
                Slug / Identifier
                <span class="article-editor__hint">(auto-generated, change only if you know what you're doing)</span>
              </label>
              <input
                type="text"
                id="article-identifier"
                class="input"
                placeholder="my-article-slug"
                value="${this.escapeHtml(this.identifier)}"
                data-field="identifier"
                title="Unique identifier for this article. Changing this after publishing creates a new article instead of updating."
              />
            </div>
          </div>
        </details>
      </div>
    `;
  }

  /**
   * Render preview mode content
   */
  private renderPreviewMode(): string {
    const htmlContent = this.renderMarkdownContent(this.content);

    return `
      <div class="article-editor__preview">
        ${this.image ? `<img src="${this.escapeHtml(this.image)}" alt="${this.escapeHtml(this.title)}" class="article-editor__preview-image" />` : ''}
        <h1 class="article-editor__preview-title">${this.escapeHtml(this.title) || 'Untitled'}</h1>
        ${this.summary ? `<p class="article-editor__preview-summary">${this.escapeHtml(this.summary)}</p>` : ''}
        <div class="article-editor__preview-content">${htmlContent}</div>
        ${this.tags ? `
          <div class="article-editor__preview-tags">
            ${this.tags.split(',').map(tag => `<span class="article-editor__preview-tag">#${this.escapeHtml(tag.trim())}</span>`).join('')}
          </div>
        ` : ''}
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
    setupTabClickHandlers(this.container, (tabId) => this.switchTab(tabId as TabMode));

    // Field inputs
    this.setupFieldListeners();

    // Relay selector
    const relaySelectorContainer = this.container.querySelector('.post-note-relay-selector');
    if (this.relaySelector && relaySelectorContainer) {
      this.relaySelector.setupEventListeners(relaySelectorContainer as HTMLElement);
    }

    // Footer Toolbar (emoji, media for footer)
    const toolbarContainer = this.container.querySelector('.post-note-toolbar');
    if (this.toolbar && toolbarContainer) {
      this.toolbar.setupEventListeners(toolbarContainer as HTMLElement);
    }

    // Markdown toolbar
    this.setupMarkdownToolbar();

    // Cover image upload
    this.setupCoverUpload();

    // Mention autocomplete
    this.mentionAutocomplete = new MentionAutocomplete({
      textareaSelector: '.article-editor-content',
      onMentionInserted: (_npub, username) => {
        this.systemLogger.info('ArticleEditorView', `Mention inserted: @${username}`);
      }
    });
    this.mentionAutocomplete.init();

    // Action buttons
    const saveDraftBtn = this.container.querySelector('[data-action="save-draft"]');
    saveDraftBtn?.addEventListener('click', () => this.handleSaveDraft());

    const publishBtn = this.container.querySelector('[data-action="publish"]');
    publishBtn?.addEventListener('click', () => this.handlePublish());

    // Auto-generate slug from title
    const titleInput = this.container.querySelector('[data-field="title"]') as HTMLInputElement;
    titleInput?.addEventListener('blur', () => {
      if (this.title && !this.identifier.includes('-')) {
        // Only auto-generate if identifier hasn't been customized
        this.identifier = ArticleService.generateIdentifier(this.title);
        const identifierInput = this.container.querySelector('[data-field="identifier"]') as HTMLInputElement;
        if (identifierInput) {
          identifierInput.value = this.identifier;
        }
      }
    });
  }

  /**
   * Setup Markdown toolbar event listeners
   */
  private setupMarkdownToolbar(): void {
    const buttons = this.container.querySelectorAll('[data-md-action]');
    const fileInput = this.container.querySelector('[data-md-file-input]') as HTMLInputElement;

    buttons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = (e.currentTarget as HTMLElement).dataset.mdAction;
        this.handleMarkdownAction(action || '');
      });
    });

    // File input for image upload
    if (fileInput) {
      fileInput.addEventListener('change', async (e) => {
        const target = e.target as HTMLInputElement;
        if (target.files && target.files.length > 0) {
          await this.handleContentImageUpload(target.files[0]);
          target.value = '';
        }
      });
    }
  }

  /**
   * Handle Markdown formatting action
   */
  private handleMarkdownAction(action: string): void {
    const textarea = this.container.querySelector('.article-editor-content') as HTMLTextAreaElement;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = this.content.slice(start, end);
    const before = this.content.slice(0, start);
    const after = this.content.slice(end);

    let insertion = '';
    let cursorOffset = 0;

    switch (action) {
      case 'heading':
        insertion = selectedText ? `## ${selectedText}` : '## ';
        cursorOffset = selectedText ? insertion.length : 3;
        break;
      case 'bold':
        insertion = selectedText ? `**${selectedText}**` : '****';
        cursorOffset = selectedText ? insertion.length : 2;
        break;
      case 'italic':
        insertion = selectedText ? `*${selectedText}*` : '**';
        cursorOffset = selectedText ? insertion.length : 1;
        break;
      case 'quote':
        insertion = selectedText ? `> ${selectedText}` : '> ';
        cursorOffset = insertion.length;
        break;
      case 'image':
        // Trigger file input
        const fileInput = this.container.querySelector('[data-md-file-input]') as HTMLInputElement;
        fileInput?.click();
        return;
    }

    this.content = before + insertion + after;
    textarea.value = this.content;

    // Set cursor position
    const newPos = start + cursorOffset;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();

    this.updateButtonStates();
  }

  /**
   * Handle content image upload (from Markdown toolbar)
   */
  private async handleContentImageUpload(file: File): Promise<void> {
    if (!file.type.startsWith('image/')) return;

    const textarea = this.container.querySelector('.article-editor-content') as HTMLTextAreaElement;
    if (!textarea) return;

    try {
      const result = await this.mediaUploadService.uploadFile(file);

      if (result.success && result.url) {
        const start = textarea.selectionStart;
        const before = this.content.slice(0, start);
        const after = this.content.slice(start);

        const insertion = `![](${result.url})\n`;
        this.content = before + insertion + after;
        textarea.value = this.content;

        const newPos = start + insertion.length;
        textarea.setSelectionRange(newPos, newPos);
        textarea.focus();

        this.updateButtonStates();
        this.systemLogger.info('ArticleEditorView', 'Image uploaded and inserted');
      }
    } catch (_error) {
      this.systemLogger.error('ArticleEditorView', 'Image upload failed:', _error);
    }
  }

  /**
   * Setup cover image upload
   */
  private setupCoverUpload(): void {
    const uploadBtn = this.container.querySelector('[data-action="upload-cover"]');
    const fileInput = this.container.querySelector('[data-cover-file]') as HTMLInputElement;

    uploadBtn?.addEventListener('click', () => {
      if (!this.isCoverUploading) {
        fileInput?.click();
      }
    });

    fileInput?.addEventListener('change', async (e) => {
      const target = e.target as HTMLInputElement;
      if (target.files && target.files.length > 0) {
        await this.handleCoverUpload(target.files[0]);
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
    const uploadBtn = this.container.querySelector('[data-action="upload-cover"]') as HTMLButtonElement;
    const imageInput = this.container.querySelector('[data-field="image"]') as HTMLInputElement;

    // Show loading state
    if (uploadBtn) {
      uploadBtn.innerHTML = `
        <svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
          <path d="M21 12a9 9 0 11-6.219-8.56"/>
        </svg>
      `;
      uploadBtn.disabled = true;
    }

    try {
      const result = await this.mediaUploadService.uploadFile(file);

      if (result.success && result.url) {
        this.image = result.url;
        if (imageInput) {
          imageInput.value = result.url;
        }
        this.systemLogger.info('ArticleEditorView', 'Cover image uploaded');
      }
    } catch (_error) {
      this.systemLogger.error('ArticleEditorView', 'Cover upload failed:', _error);
    } finally {
      this.isCoverUploading = false;
      if (uploadBtn) {
        uploadBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
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
      field.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement | HTMLTextAreaElement;
        const fieldName = target.dataset.field as string;

        switch (fieldName) {
          case 'title':
            this.title = target.value;
            break;
          case 'content':
            this.content = target.value;
            break;
          case 'summary':
            this.summary = target.value;
            break;
          case 'image':
            this.image = target.value;
            break;
          case 'tags':
            this.tags = target.value;
            break;
          case 'identifier':
            this.identifier = target.value;
            break;
        }

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
          onMentionInserted: (_npub, _username) => {}
        });
        this.mentionAutocomplete.init();
      } else {
        body.innerHTML = this.renderPreviewMode();
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

    const publishBtn = this.container.querySelector('[data-action="publish"]') as HTMLButtonElement;
    const saveDraftBtn = this.container.querySelector('[data-action="save-draft"]') as HTMLButtonElement;

    if (publishBtn) {
      publishBtn.disabled = !isValid || this.isPublishing;
    }
    if (saveDraftBtn) {
      saveDraftBtn.disabled = !isValid || this.isPublishing;
    }
  }

  /**
   * Handle back navigation
   */
  private handleBack(): void {
    // See docs/todos/article-editor-unsaved-changes.md
    this.router.navigate('/');
  }

  /**
   * Handle media uploaded (from footer toolbar)
   */
  private handleMediaUploaded(url: string): void {
    const textarea = this.container.querySelector('.article-editor-content') as HTMLTextAreaElement;
    if (!textarea) return;

    // Insert at cursor position or append
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = this.content.slice(0, start);
    const after = this.content.slice(end);

    // Determine if it's an image
    const isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(url);
    const insertion = isImage ? `\n![](${url})\n` : `\n${url}\n`;

    this.content = before + insertion + after;
    textarea.value = this.content;

    // Move cursor after insertion
    const newPos = start + insertion.length;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();

    this.updateButtonStates();
  }

  /**
   * Handle emoji selected
   */
  private handleEmojiSelected(emoji: string): void {
    const textarea = this.container.querySelector('.article-editor-content') as HTMLTextAreaElement;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = this.content.slice(0, start);
    const after = this.content.slice(end);

    this.content = before + emoji + after;
    textarea.value = this.content;

    const newPos = start + emoji.length;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();

    this.updateButtonStates();
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
      // Parse tags
      const topics = this.tags
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);

      const naddr = isDraft
        ? await this.articleService.saveDraft({
            title: this.title,
            content: this.content,
            identifier: this.identifier || ArticleService.generateIdentifier(this.title),
            summary: this.summary || undefined,
            image: this.image || undefined,
            topics: topics.length > 0 ? topics : undefined,
            relays: Array.from(this.selectedRelays)
          })
        : await this.articleService.publishArticle({
            title: this.title,
            content: this.content,
            identifier: this.identifier || ArticleService.generateIdentifier(this.title),
            summary: this.summary || undefined,
            image: this.image || undefined,
            topics: topics.length > 0 ? topics : undefined,
            relays: Array.from(this.selectedRelays)
          });

      if (naddr && !isDraft) {
        // Navigate to the published article
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
    if (!content) return '<p class="article-editor__preview-empty">No content yet...</p>';

    try {
      marked.setOptions({
        breaks: true,
        gfm: true
      });

      const html = marked.parse(content) as string;
      // Add rel for security - global handler in App.ts opens external links
      return html.replace(/<a href=/g, '<a rel="noopener noreferrer" href=');
    } catch (_err) {
      return `<p>${this.escapeHtml(content)}</p>`;
    }
  }

  /**
   * Escape HTML
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Get element
   */
  public getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Destroy view
   */
  public destroy(): void {
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
