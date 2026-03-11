/**
 * ListingEditorView - Full-page editor for NIP-99 classified listings
 *
 * Create mode: /write-listing
 * Edit mode: /write-listing/:naddr (loads existing listing data)
 *
 * Pattern: Follows ArticleEditorView structure.
 */

import { View } from '../../components/views/View';
import { Router } from '../../services/Router';
import { ListingService } from './ListingService';
import { RelayConfig } from '../../services/RelayConfig';
import { AuthGuard } from '../../services/AuthGuard';
import { SystemLogger } from '../../components/system/SystemLogger';
import { RelaySelector } from '../../components/post/RelaySelector';
import { PostEditorToolbar } from '../../components/post/PostEditorToolbar';
import { MentionAutocomplete } from '../../components/mentions/MentionAutocomplete';
import { MediaUploadService } from '../../services/MediaUploadService';
import { LongFormOrchestrator } from '../../services/orchestration/LongFormOrchestrator';
import { parseListingMetadata } from './marketplace-helpers';
import { marked } from 'marked';
import { setupTabClickHandlers, switchTab } from '../../helpers/TabsHelper';
import { escapeHtml } from '../../helpers/escapeHtml';

type TabMode = 'edit' | 'preview';

export class ListingEditorView extends View {
  private container: HTMLElement;
  private router: Router;
  private listingService: ListingService;
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
  private price: string = '';
  private priceCurrency: string = 'USD';
  private priceFrequency: string = '';
  private location: string = '';
  private tags: string = '';
  private identifier: string = '';
  private images: string[] = [];
  private status: string = 'active';
  private selectedRelays: Set<string> = new Set();
  private availableRelays: string[] = [];
  private isTestMode: boolean = false;
  private isPublishing: boolean = false;
  private isImageUploading: boolean = false;

  // Edit mode
  private editNaddr: string | null;
  private isEditMode: boolean = false;

  constructor(naddr?: string) {
    super();
    this.editNaddr = naddr || null;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--listing-editor';
    this.router = Router.getInstance();
    this.listingService = ListingService.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.mediaUploadService = MediaUploadService.getInstance();

    this.identifier = ListingService.generateIdentifier();
    this.loadRelayConfiguration();

    if (this.editNaddr) {
      this.loadExistingListing();
    } else {
      this.render();
    }
  }

  private loadRelayConfiguration(): void {
    const localRelaySettings = this.loadLocalRelaySettings();
    if (localRelaySettings.enabled) {
      this.isTestMode = true;
      this.availableRelays = [localRelaySettings.url];
      this.selectedRelays = new Set([localRelaySettings.url]);
    } else {
      this.isTestMode = false;
      const allRelays = this.relayConfig.getAllRelays();
      this.availableRelays = [...new Set(allRelays.filter(r => r.isActive).map(r => r.url))];
      this.selectedRelays = new Set([...new Set(this.relayConfig.getWriteRelays())]);
    }
  }

  private loadLocalRelaySettings(): { enabled: boolean; url: string } {
    try {
      const stored = localStorage.getItem('noornote_local_relay');
      if (stored) return JSON.parse(stored);
    } catch (_err) { /* ignore */ }
    return { enabled: false, url: 'ws://localhost:7777' };
  }

  /**
   * Load existing listing for edit mode
   */
  private async loadExistingListing(): Promise<void> {
    this.container.innerHTML = '<div class="marketplace-timeline__empty pulsate"><p>Loading listing...</p></div>';

    try {
      const orchestrator = LongFormOrchestrator.getInstance();
      const event = await orchestrator.fetchAddressableEvent(this.editNaddr!);

      if (!event) {
        this.container.innerHTML = '<div class="marketplace-timeline__error"><p>Listing not found</p></div>';
        return;
      }

      const meta = parseListingMetadata(event);

      this.isEditMode = true;
      this.title = meta.title;
      this.content = event.content || '';
      this.summary = meta.summary;
      this.price = meta.price;
      this.priceCurrency = meta.priceCurrency || 'USD';
      this.priceFrequency = meta.priceFrequency;
      this.location = meta.location;
      this.tags = meta.tags.join(', ');
      this.identifier = meta.identifier;
      this.images = meta.images;
      this.status = meta.status || 'active';

      this.render();
    } catch (error) {
      this.systemLogger.error('ListingEditorView', 'Failed to load listing:', error);
      this.container.innerHTML = '<div class="marketplace-timeline__error"><p>Failed to load listing</p></div>';
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
      onMediaUploaded: (url) => this.handleMediaUploaded(url),
      onEmojiSelected: (emoji) => this.insertAtCursor(emoji),
      textareaSelector: '.listing-editor-content',
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
          <h1 class="article-editor__title">${this.isEditMode ? 'Edit Listing' : 'New Listing'}</h1>
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
            <button class="btn" data-action="publish">${this.isEditMode ? 'Update Listing' : 'Publish Listing'}</button>
          </div>
        </footer>
      </div>
    `;

    this.setupEventListeners();
  }

  private renderEditMode(): string {
    const statusOptions = ['active', 'sold', 'inactive'];
    const currencyOptions = ['USD', 'EUR', 'GBP', 'BTC', 'SAT'];
    const frequencyOptions = [
      { value: '', label: 'One-time' },
      { value: 'hour', label: 'per hour' },
      { value: 'day', label: 'per day' },
      { value: 'month', label: 'per month' },
      { value: 'year', label: 'per year' }
    ];

    return `
      <div class="article-editor__form">
        <div class="form__row">
          <label for="listing-title">Title *</label>
          <input type="text" id="listing-title" class="input input--title" placeholder="Product name..." value="${escapeHtml(this.title)}" data-field="title" />
        </div>

        <div class="form__row">
          <label for="listing-price">Price *</label>
          <div class="listing-editor__price-row">
            <input type="text" id="listing-price" class="input" placeholder="50" value="${escapeHtml(this.price)}" data-field="price" style="flex: 1;" />
            <select id="listing-currency" class="input listing-editor__currency-select" data-field="priceCurrency">
              ${currencyOptions.map(c => `<option value="${c}" ${this.priceCurrency === c ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
            <select id="listing-frequency" class="input listing-editor__frequency-select" data-field="priceFrequency">
              ${frequencyOptions.map(f => `<option value="${f.value}" ${this.priceFrequency === f.value ? 'selected' : ''}>${f.label}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="form__row">
          <label for="listing-image-url">Images</label>
          <div class="listing-editor__images">
            <div class="listing-editor__image-list">
              ${this.images.map((url, i) => `
                <div class="listing-editor__image-item" data-index="${i}">
                  <img src="${escapeHtml(url)}" alt="" />
                  <button type="button" class="btn-icon listing-editor__image-remove" data-remove-image="${i}" title="Remove">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>
              `).join('')}
            </div>
            <div class="listing-editor__image-add">
              <input type="text" id="listing-image-url" class="input" placeholder="https://... or upload" data-field="image-url" />
              <button type="button" class="btn-icon" data-action="add-image-url" title="Add URL">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
              </button>
              <button type="button" class="btn-icon" data-action="upload-image" title="Upload image">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </button>
              <input type="file" accept="image/*" data-image-file style="display: none;" />
            </div>
          </div>
        </div>

        <div class="form__row">
          <label for="listing-content">Description (Markdown)</label>
          <textarea id="listing-content" class="textarea textarea--large listing-editor-content" placeholder="Describe your product..." data-field="content">${escapeHtml(this.content)}</textarea>
        </div>

        <section class="nn-ui-toggle">
          <div class="nn-ui-toggle__header">
            <div class="nn-ui-toggle__info">
              <h2 class="nn-ui-toggle__title">Details</h2>
            </div>
            <button class="nn-ui-toggle__toggle" aria-label="Toggle section">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </button>
          </div>
          <div class="nn-ui-toggle__content">
            <div class="form__row">
              <label for="listing-summary">Summary</label>
              <textarea id="listing-summary" class="textarea textarea--small" placeholder="Brief description for listing cards..." data-field="summary">${escapeHtml(this.summary)}</textarea>
            </div>

            <div class="form__row">
              <label for="listing-location">Location</label>
              <input type="text" id="listing-location" class="input" placeholder="Berlin, DE" value="${escapeHtml(this.location)}" data-field="location" />
            </div>

            <div class="form__row">
              <label for="listing-tags">Tags</label>
              <input type="text" id="listing-tags" class="input" placeholder="electronics, vintage (comma separated)" value="${escapeHtml(this.tags)}" data-field="tags" />
            </div>

            ${this.isEditMode ? `
              <div class="form__row">
                <label for="listing-status">Status</label>
                <select id="listing-status" class="input" data-field="status">
                  ${statusOptions.map(s => `<option value="${s}" ${this.status === s ? 'selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`).join('')}
                </select>
              </div>
            ` : ''}

            <div class="form__row">
              <label for="listing-identifier">Slug / Identifier</label>
              <span class="form__note">(auto-generated${this.isEditMode ? ', do not change' : ''})</span>
              <input type="text" id="listing-identifier" class="input" value="${escapeHtml(this.identifier)}" data-field="identifier" ${this.isEditMode ? 'disabled' : ''} />
            </div>
          </div>
        </section>
      </div>
    `;
  }

  private renderPreviewMode(): string {
    const priceDisplay = this.price && this.priceCurrency
      ? `${this.price} ${this.priceCurrency}${this.priceFrequency ? '/' + this.priceFrequency : ''}`
      : '';

    let htmlContent = '';
    try {
      marked.setOptions({ breaks: true, gfm: true });
      htmlContent = (marked.parse(this.content) as string)
        .replace(/<a href=/g, '<a rel="noopener noreferrer" href=');
    } catch {
      htmlContent = `<p>${escapeHtml(this.content)}</p>`;
    }

    return `
      <div class="article-editor__preview">
        ${this.images.length > 0 && this.images[0] ? `<img src="${escapeHtml(this.images[0])}" alt="${escapeHtml(this.title)}" class="article-editor__preview-image" />` : ''}
        <h1 class="article-editor__preview-title">${escapeHtml(this.title) || 'Untitled'}</h1>
        ${priceDisplay ? `<div class="listing-card__price" style="font-size: 1.25rem; margin-bottom: 1rem;">${escapeHtml(priceDisplay)}</div>` : ''}
        ${this.location ? `<div class="listing-card__location">${escapeHtml(this.location)}</div>` : ''}
        ${this.summary ? `<p class="article-editor__preview-summary">${escapeHtml(this.summary)}</p>` : ''}
        <div class="article-editor__preview-content">${htmlContent}</div>
        ${this.tags ? `
          <div class="article-editor__preview-tags">
            ${this.tags.split(',').map(tag => `<span class="listing-card__tag">#${escapeHtml(tag.trim())}</span>`).join(' ')}
          </div>
        ` : ''}
      </div>
    `;
  }

  private setupEventListeners(): void {
    // Back
    this.container.querySelector('[data-action="back"]')?.addEventListener('click', () => {
      this.router.navigate('/marketplace');
    });

    // Tabs
    setupTabClickHandlers(this.container, (tabId) => this.switchTab(tabId as TabMode));

    // Fields
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

    // Footer toolbar
    const toolbarContainer = this.container.querySelector('.post-note-toolbar');
    if (this.toolbar && toolbarContainer) {
      this.toolbar.setupEventListeners(toolbarContainer as HTMLElement);
    }

    // Mention autocomplete
    this.mentionAutocomplete = new MentionAutocomplete({
      textareaSelector: '.listing-editor-content',
      onMentionInserted: () => {}
    });
    this.mentionAutocomplete.init();

    // Publish
    this.container.querySelector('[data-action="publish"]')?.addEventListener('click', () => this.handlePublish());

    // Image management
    this.setupImageHandlers();

    // Auto-generate slug from title (only in create mode)
    if (!this.isEditMode) {
      const titleInput = this.container.querySelector('[data-field="title"]') as HTMLInputElement;
      titleInput?.addEventListener('blur', () => {
        if (this.title && !this.identifier.includes('-')) {
          this.identifier = ListingService.generateIdentifier(this.title);
          const identifierInput = this.container.querySelector('[data-field="identifier"]') as HTMLInputElement;
          if (identifierInput) identifierInput.value = this.identifier;
        }
      });
    }
  }

  private setupFieldListeners(): void {
    const fields = this.container.querySelectorAll('[data-field]');
    fields.forEach(field => {
      const eventType = field.tagName === 'SELECT' ? 'change' : 'input';
      field.addEventListener(eventType, (e) => {
        const target = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        const fieldName = target.dataset.field;

        switch (fieldName) {
          case 'title': this.title = target.value; break;
          case 'content': this.content = target.value; break;
          case 'summary': this.summary = target.value; break;
          case 'price': this.price = target.value; break;
          case 'priceCurrency': this.priceCurrency = target.value; break;
          case 'priceFrequency': this.priceFrequency = target.value; break;
          case 'location': this.location = target.value; break;
          case 'tags': this.tags = target.value; break;
          case 'identifier': this.identifier = target.value; break;
          case 'status': this.status = target.value; break;
        }

        this.updateButtonStates();
      });
    });
  }

  private setupImageHandlers(): void {
    // Remove image buttons
    this.container.querySelectorAll('[data-remove-image]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const index = parseInt((e.currentTarget as HTMLElement).dataset.removeImage || '0');
        this.images.splice(index, 1);
        this.refreshImageList();
      });
    });

    // Add image from URL
    this.container.querySelector('[data-action="add-image-url"]')?.addEventListener('click', () => {
      const input = this.container.querySelector('[data-field="image-url"]') as HTMLInputElement;
      const url = input?.value.trim();
      if (url && url.startsWith('http')) {
        this.images.push(url);
        input.value = '';
        this.refreshImageList();
      }
    });

    // Upload image
    const uploadBtn = this.container.querySelector('[data-action="upload-image"]');
    const fileInput = this.container.querySelector('[data-image-file]') as HTMLInputElement;

    uploadBtn?.addEventListener('click', () => {
      if (!this.isImageUploading) fileInput?.click();
    });

    fileInput?.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        await this.handleImageUpload(file);
        (e.target as HTMLInputElement).value = '';
      }
    });
  }

  private async handleImageUpload(file: File): Promise<void> {
    if (!file.type.startsWith('image/') || this.isImageUploading) return;

    this.isImageUploading = true;
    const uploadBtn = this.container.querySelector('[data-action="upload-image"]') as HTMLButtonElement;
    if (uploadBtn) uploadBtn.disabled = true;

    try {
      const result = await this.mediaUploadService.uploadFile(file);
      if (result.success && result.url) {
        this.images.push(result.url);
        this.refreshImageList();
      }
    } catch (error) {
      this.systemLogger.error('ListingEditorView', 'Image upload failed:', error);
    } finally {
      this.isImageUploading = false;
      if (uploadBtn) uploadBtn.disabled = false;
    }
  }

  private refreshImageList(): void {
    const listEl = this.container.querySelector('.listing-editor__image-list');
    if (!listEl) return;

    listEl.innerHTML = this.images.map((url, i) => `
      <div class="listing-editor__image-item" data-index="${i}">
        <img src="${escapeHtml(url)}" alt="" />
        <button type="button" class="btn-icon listing-editor__image-remove" data-remove-image="${i}" title="Remove">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    `).join('');

    // Re-bind remove handlers
    listEl.querySelectorAll('[data-remove-image]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const index = parseInt((e.currentTarget as HTMLElement).dataset.removeImage || '0');
        this.images.splice(index, 1);
        this.refreshImageList();
      });
    });
  }

  private switchTab(tab: TabMode): void {
    if (tab === this.currentTab) return;
    this.currentTab = tab;

    switchTab(this.container, tab);

    const body = this.container.querySelector('.article-editor__body');
    if (body) {
      if (tab === 'edit') {
        body.innerHTML = this.renderEditMode();
        this.setupFieldListeners();
        this.setupImageHandlers();
        if (this.mentionAutocomplete) this.mentionAutocomplete.destroy();
        this.mentionAutocomplete = new MentionAutocomplete({
          textareaSelector: '.listing-editor-content',
          onMentionInserted: () => {}
        });
        this.mentionAutocomplete.init();
      } else {
        body.innerHTML = this.renderPreviewMode();
      }
    }
  }

  private updateButtonStates(): void {
    const isValid = this.title.trim().length > 0
      && this.price.trim().length > 0
      && this.priceCurrency.trim().length > 0
      && this.selectedRelays.size > 0;

    const publishBtn = this.container.querySelector('[data-action="publish"]') as HTMLButtonElement;
    if (publishBtn) publishBtn.disabled = !isValid || this.isPublishing;
  }

  private insertAtCursor(text: string): void {
    const textarea = this.container.querySelector('.listing-editor-content') as HTMLTextAreaElement;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const before = this.content.slice(0, start);
    const after = this.content.slice(textarea.selectionEnd);

    this.content = before + text + after;
    textarea.value = this.content;

    const newPos = start + text.length;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();
    this.updateButtonStates();
  }

  private handleMediaUploaded(url: string): void {
    const isImage = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(url);
    this.insertAtCursor(isImage ? `\n![](${url})\n` : `\n${url}\n`);
  }

  private async handlePublish(): Promise<void> {
    if (!AuthGuard.requireAuth('publish a listing')) return;
    if (this.isPublishing) return;

    this.isPublishing = true;
    this.updateButtonStates();

    const btn = this.container.querySelector('[data-action="publish"]') as HTMLButtonElement;
    const originalText = btn?.textContent || '';
    if (btn) btn.textContent = this.isEditMode ? 'Updating...' : 'Publishing...';

    try {
      const topics = this.tags.split(',').map(t => t.trim()).filter(Boolean);

      const options: Parameters<typeof this.listingService.publishListing>[0] = {
        title: this.title,
        content: this.content,
        identifier: this.identifier || ListingService.generateIdentifier(this.title),
        price: this.price,
        priceCurrency: this.priceCurrency,
        relays: Array.from(this.selectedRelays)
      };

      if (this.summary) options.summary = this.summary;
      if (this.images.length > 0) options.images = this.images;
      if (this.priceFrequency) options.priceFrequency = this.priceFrequency;
      if (this.location) options.location = this.location;
      if (this.status !== 'active') options.status = this.status;
      if (topics.length > 0) options.topics = topics;

      const naddr = await this.listingService.publishListing(options);

      if (naddr) {
        this.router.navigate(`/listing/${naddr}`);
      }
    } finally {
      this.isPublishing = false;
      if (btn) btn.textContent = originalText;
      this.updateButtonStates();
    }
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.relaySelector) { this.relaySelector.destroy(); this.relaySelector = null; }
    if (this.toolbar) { this.toolbar.destroy(); this.toolbar = null; }
    if (this.mentionAutocomplete) { this.mentionAutocomplete.destroy(); this.mentionAutocomplete = null; }
    this.container.innerHTML = '';
  }
}
