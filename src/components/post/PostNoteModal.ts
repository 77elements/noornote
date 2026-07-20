/**
 * PostNoteModal Component
 * Modal dialog for creating and publishing new notes (Kind 1 events)
 *
 * Features:
 * - Edit/Preview tabs
 * - Multi-relay selector (TEST mode = local relay only)
 * - Content preview with ContentProcessor
 * - Publish to selected relays via PostService
 *
 * Architecture: Uses modular sub-components for maintainability
 */

import { ModalService } from '../../services/ModalService';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { PostsModuleApi } from '../../modules/posts/contracts';
import { RelayConfig } from '../../services/RelayConfig';
import { loadEditorRelayConfig } from '../../helpers/editorRelayConfig';
import { switchComposerTab } from '../../helpers/switchComposerTab';
import { SystemLogger } from '../../services/SystemLogger';
import { AuthService } from '../../services/AuthService';
import { AuthGuard } from '../../services/AuthGuard';
import { RelaySelector } from './RelaySelector';
import { ClientTagControl } from './ClientTagControl';
import { PostEditorToolbar } from './PostEditorToolbar';
import { renderPostPreview } from '../../helpers/renderPostPreview';
import { setupPasteUpload } from '../../helpers/pasteUpload';
import { stripTrackingParams } from '../../helpers/stripTrackingParams';
import { Switch } from '../ui/Switch';
import { PollCreator, type PollData } from '../poll/PollCreator';
import { extractQuotedReferences } from '../../helpers/extractQuotedReferences';
import { renderQuotePreview } from '../../helpers/renderQuotePreview';
import { decodeNip19 } from '../../services/NostrToolsAdapter';
import type { ReactionsModuleApi } from '../../modules/reactions/contracts';
import { AppState } from '../../services/AppState';
import { ContentValidationManager } from './ContentValidationManager';
import { EditorStateManager } from './EditorStateManager';
import { MentionAutocomplete } from '../mentions/MentionAutocomplete';
import { ProfileSearchComponent } from '../profile/ProfileSearchComponent';
import { isCustomEmojisEnabled } from '../../addons/custom-emojis/index';
import { isScheduledPostsEnabled } from '../../addons/scheduled-posts/index';
import { ModalEventHandlerManager, type TabMode } from '../modals/ModalEventHandlerManager';
import { escapeHtml } from '../../helpers/escapeHtml';
import { NoteDraftService } from '../../services/NoteDraftService';
import { ToastService } from '../../services/ToastService';
import { SignerTimeoutError } from '../../services/SignerTimeoutError';
import { renderDraftsList, setupDraftsList } from './DraftsListUI';
import { openDraftInComposer } from '../../helpers/draftRouter';
import { attachPreviewClickToEdit } from '../../helpers/previewClickToEdit';
import { isImageUrl } from '../../helpers/extractMedia';
import { UserProfileService } from '../../services/UserProfileService';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export interface HighlightSource {
  /** The selected text passage (verbatim quote of source) */
  selectedText: string;
  /** The source event being highlighted */
  event: NostrEvent;
}

/**
 * One tagged user inside an image (NIP-68).
 * `pubkey` is the canonical hex; `npub` and `username` are cached for
 * re-rendering the chips without an extra profile round-trip.
 */
export interface ImageTagEntry {
  pubkey: string;
  npub: string;
  username: string;
}

export class PostNoteModal {
  private static instance: PostNoteModal;
  private modalService: ModalService;
  private _postsApi?: PostsModuleApi | null;
  private get postsApi(): PostsModuleApi | null {
    return this._postsApi ??= ModuleLoader.getInstance().getApi<PostsModuleApi>('posts');
  }
  private relayConfig: RelayConfig;
  private authService: AuthService;
  private systemLogger: SystemLogger;
  private appState: AppState;

  // Sub-components
  private relaySelector: RelaySelector | null = null;
  private clientTagControl: ClientTagControl | null = null;
  private toolbar: PostEditorToolbar | null = null;
  private nsfwSwitch: Switch | null = null;
  private pollCreator: PollCreator | null = null;
  private mentionAutocomplete: MentionAutocomplete | null = null;
  private customEmojiAutocomplete: import('../../addons/custom-emojis/CustomEmojiAutocomplete').CustomEmojiAutocomplete | null = null;
  private customEmojiService: import('../../addons/custom-emojis/EmojiService').EmojiService | null = null;
  private eventHandlerManager: ModalEventHandlerManager | null = null;

  // State
  private currentTab: TabMode = 'edit';
  private content: string = '';
  private selectedRelays: Set<string> = new Set();
  private availableRelays: string[] = [];
  private isTestMode: boolean = false;
  private isNSFW: boolean = false;
  private pollData: PollData | null = null;
  private scheduledAt: number | null = null;
  private highlightSource: HighlightSource | null = null;
  // Per-post custom client tag — overrides the global "via NoorNote" UI setting
  // for this one note. Empty = fall back to the UI setting (see AuthService.signEvent).
  private customClientTag: string = '';

  // NIP-68 image tagging state — one entry per uploaded image URL.
  // Map preserves insertion order (ES2015 guarantee), so thumbnails and the
  // underlying text URLs stay in lockstep.
  private imageTags: Map<string, ImageTagEntry[]> = new Map();
  // Per-thumbnail ProfileSearchComponent instances (lazily created on first
  // tag-button click). Reused across reopens so chip state survives.
  private tagOverlays: Map<string, ProfileSearchComponent> = new Map();
  // Mention autocomplete instances, keyed the same way.
  private tagMentionAutocompletes: Map<string, MentionAutocomplete> = new Map();
  // Hard cap per image (NIP-68 has no protocol limit; we enforce a UI one).
  private static readonly MAX_TAGS_PER_IMAGE = 50;

  private constructor() {
    this.modalService = ModalService.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.authService = AuthService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.appState = AppState.getInstance();
  }

  public static getInstance(): PostNoteModal {
    if (!PostNoteModal.instance) {
      PostNoteModal.instance = new PostNoteModal();
    }
    return PostNoteModal.instance;
  }

  /**
   * Show the post note modal
   * @param options - Either a pre-filled content string (legacy quoted reposts)
   *                  or an options object with optional `highlightSource` to
   *                  switch into NIP-84 Highlight mode.
   */
  public show(options?: string | { initialContent?: string; highlightSource?: HighlightSource }): void {
    let initialContent: string | undefined;
    if (typeof options === 'string') {
      initialContent = options;
    } else if (options) {
      initialContent = options.initialContent;
      this.highlightSource = options.highlightSource ?? null;
    }

    this.currentTab = 'edit';
    // Composer always starts from the explicit initial content (quoted repost,
    // shared image, opened draft) or empty — unsent text is only ever kept via
    // the explicit "Save as draft?" prompt, never silently restored.
    this.content = initialContent ?? '';
    this.customClientTag = '';
    this.loadRelayConfiguration();

    const modalContent = this.renderContent();

    this.modalService.show({
      title: this.highlightSource ? 'New Highlight' : 'New Note',
      content: modalContent,
      width: '650px',
      height: 'auto',
      showCloseButton: true,
      closeOnOverlay: false,
      closeOnEsc: true,
      onBeforeClose: () => this.confirmDiscardOrSave()
    });

    setTimeout(() => {
      this.setupEventHandlers();
    }, 0);
  }

  /**
   * Load relay configuration based on TEST mode and timeline filter
   */
  private loadRelayConfiguration(): void {
    const cfg = loadEditorRelayConfig(this.relayConfig);
    this.isTestMode = cfg.isTestMode;
    this.availableRelays = cfg.availableRelays;
    this.selectedRelays = cfg.selectedRelays;

    if (cfg.isTestMode) {
      this.systemLogger.info('PostNoteModal', 'TEST mode: Using local relay only');
      return;
    }

    // Relay-filtered timeline active → pre-select only that relay (on top of base).
    const selectedRelay = this.appState.getState('timeline').selectedRelay;
    if (selectedRelay) {
      this.selectedRelays = new Set([selectedRelay]);
      this.systemLogger.info('PostNoteModal', `Relay filter active: Pre-selecting ${selectedRelay}`);
    } else {
      this.systemLogger.info('PostNoteModal', `Normal mode: ${this.availableRelays.length} relays available`);
    }
  }


  /**
   * Render modal content
   */
  private renderContent(): string {
    return `
      <div class="post-note-modal">
        ${this.renderTabs()}
        ${this.renderHighlightQuote()}
        ${this.renderEditor()}
        <div id="poll-creator-container"></div>
        ${this.renderActions()}
      </div>
    `;
  }

  /**
   * Render the read-only quote box for Highlight mode (NIP-84).
   * The user cannot edit the source passage; their thoughts go in the textarea.
   */
  private renderHighlightQuote(): string {
    if (!this.highlightSource) return '';
    return `
      <div class="post-note-highlight-quote">
        <blockquote class="highlight__quote">${escapeHtml(this.highlightSource.selectedText)}</blockquote>
      </div>
    `;
  }

  /**
   * Render tabs header (Edit/Preview + Relay Selector)
   */
  private renderTabs(): string {
    // Create relay selector component
    this.relaySelector = new RelaySelector({
      availableRelays: this.availableRelays,
      selectedRelays: this.selectedRelays,
      isTestMode: this.isTestMode,
      onChange: (selectedRelays) => {
        this.selectedRelays = selectedRelays;
        this.updatePostButton();
      }
    });

    // Per-post custom client tag control (mounted into modal__header, see setupEventHandlers)
    this.clientTagControl = new ClientTagControl({
      initialValue: this.customClientTag,
      onChange: (value) => {
        this.customClientTag = value;
      }
    });

    return `
      <div class="post-note-header">
        <div class="tabs">
          <button
            class="tab ${this.currentTab === 'edit' ? 'tab--active' : ''}"
            data-tab="edit"
          >
            Edit
          </button>
          <button
            class="tab ${this.currentTab === 'preview' ? 'tab--active' : ''}"
            data-tab="preview"
          >
            Preview
          </button>
          <button
            class="tab ${this.currentTab === 'drafts' ? 'tab--active' : ''}"
            data-tab="drafts"
          >${this.renderDraftsTabLabel()}</button>
        </div>
      </div>
    `;
  }

  /**
   * Tab label for the Drafts tab, with a count badge when drafts exist.
   */
  private renderDraftsTabLabel(): string {
    const count = NoteDraftService.getInstance().count();
    return `Drafts${count > 0 ? ` <span class="badge badge--accent">${count}</span>` : ''}`;
  }

  /**
   * Refresh the Drafts tab count badge in place.
   */
  private updateDraftsTabBadge(): void {
    const btn = document.querySelector('.post-note-modal [data-tab="drafts"]') as HTMLElement | null;
    if (btn) btn.innerHTML = this.renderDraftsTabLabel();
  }

  /**
   * Toggle the tab--active class across the composer tabs.
   */
  private setActiveTab(tab: TabMode): void {
    document.querySelectorAll('.post-note-modal [data-tab]').forEach(el => {
      const tabEl = el as HTMLElement;
      tabEl.classList.toggle('tab--active', tabEl.dataset.tab === tab);
    });
  }

  /**
   * Render editor/preview area
   */
  private renderEditor(): string {
    if (this.currentTab === 'edit') {
      const placeholder = this.highlightSource
        ? 'Write your thoughts about this highlight (optional)…'
        : "What's on your mind?";
      return `
        <textarea
          class="textarea"
          placeholder="${escapeHtml(placeholder)}"
          data-textarea
        >${this.content}</textarea>
        <div class="post-note-modal__media-strip" id="post-note-media-strip"></div>
      `;
    } else {
      const currentUser = this.authService.getCurrentUser();
      const cleanedContent = stripTrackingParams(this.content);
      const extraTags = this.buildPreviewEmojiTags(cleanedContent);
      const previewHTML = renderPostPreview({
        content: cleanedContent,
        pubkey: currentUser?.pubkey || '',
        isNSFW: this.isNSFW,
        ...(extraTags.length > 0 ? { extraTags } : {})
      });

      return `<div class="post-note-preview">${previewHTML}</div>`;
    }
  }

  /**
   * Render action buttons
   */
  private renderActions(): string {
    // Create toolbar component
    this.toolbar = new PostEditorToolbar({
      onMediaUploaded: (url) => this.handleMediaUploaded(url),
      onEmojiSelected: (emoji) => this.handleEmojiSelected(emoji),
      onPollToggle: () => this.handlePollToggle(),
      onScheduleClick: () => this.handleScheduleClick(),
      textareaSelector: '[data-textarea]',
      showSchedule: isScheduledPostsEnabled(),
    });

    // Highlight mode: comment is optional, only require relays.
    // Regular notes: require content (or poll) + relays.
    const isValid = this.highlightSource
      ? this.selectedRelays.size > 0
      : ContentValidationManager.validate({
          content: this.content,
          selectedRelays: this.selectedRelays,
          pollData: this.pollData
        }).isValid;

    const postButtonLabel = this.highlightSource
      ? 'Post Highlight'
      : (this.scheduledAt !== null ? 'Schedule' : 'Post');
    return `
      <div class="l-row l-row--split">
        <div>
          ${this.toolbar.render()}
          <div class="post-note-options" id="post-note-options-container"></div>
          <div class="post-note-schedule-hint" id="post-note-schedule-hint">${this.renderScheduleHintHtml()}</div>
        </div>
        <div>
          ${this.highlightSource ? '' : '<button class="btn btn--passive" data-action="save-draft">Save draft</button>'}
          <button class="btn btn--passive" data-action="cancel">Cancel</button>
          <button class="btn" data-action="post" ${isValid ? '' : 'disabled'}>${postButtonLabel}</button>
        </div>
      </div>
    `;
  }

  /**
   * Render the "will be published on..." hint when a schedule is set.
   */
  private renderScheduleHintHtml(): string {
    if (this.scheduledAt === null) return '';
    const when = new Date(this.scheduledAt * 1000).toLocaleString();
    return `
      <span class="post-note-schedule-hint__icon">
        <svg width="14" height="14"><use href="#icon-calendar"/></svg>
      </span>
      <span class="post-note-schedule-hint__text">Will be published on ${escapeHtml(when)}</span>
      <button type="button" class="post-note-schedule-hint__clear" data-action="clear-schedule">Clear</button>
    `;
  }

  /**
   * Update the schedule hint block (no full re-render).
   * Click-handler is attached via event delegation on the hint root,
   * so it survives any subsequent innerHTML replacements.
   */
  private updateScheduleHint(): void {
    const hintEl = document.querySelector('#post-note-schedule-hint') as HTMLElement | null;
    if (!hintEl) return;
    hintEl.innerHTML = this.renderScheduleHintHtml();
    if (!hintEl.dataset.delegated) {
      hintEl.dataset.delegated = 'true';
      hintEl.addEventListener('click', (e) => {
        const target = (e.target as HTMLElement).closest('[data-action="clear-schedule"]');
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        this.scheduledAt = null;
        this.updateScheduleHint();
        this.updatePostButtonLabel();
      });
    }
  }

  /**
   * Update the Post/Schedule button label based on scheduledAt state.
   */
  private updatePostButtonLabel(): void {
    const btn = document.querySelector('[data-action="post"]') as HTMLButtonElement | null;
    if (!btn) return;
    btn.textContent = this.scheduledAt !== null ? 'Schedule' : 'Post';
  }

  /**
   * Open the date/time picker to schedule this post.
   */
  private async handleScheduleClick(): Promise<void> {
    const { pickDateTime } = await import('../../helpers/datePickerModal');
    const initial = this.scheduledAt
      ? new Date(this.scheduledAt * 1000)
      : new Date(Date.now() + 60 * 60 * 1000); // Default: +1h
    const anchorEl = document.querySelector(
      '.post-note-toolbar [data-action="schedule"]'
    ) as HTMLElement | null;
    const picked = await pickDateTime({
      title: 'Schedule Post',
      initial,
      min: new Date(Date.now() + 60 * 1000),
      max: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      confirmLabel: 'Schedule',
      ...(anchorEl ? { anchorEl } : {}),
    });
    if (!picked) return;
    this.scheduledAt = Math.floor(picked.getTime() / 1000);
    this.updateScheduleHint();
    this.updatePostButtonLabel();
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    const modal = document.querySelector('.post-note-modal');
    if (!modal) return;

    // Mount relay selector into modal__header (outside overflow container)
    const modalHeader = modal.closest('.modal__body')?.previousElementSibling as HTMLElement;
    if (this.relaySelector && modalHeader) {
      const relaySelectorDiv = document.createElement('div');
      relaySelectorDiv.innerHTML = this.relaySelector.render();
      const relaySelectorEl = relaySelectorDiv.firstElementChild as HTMLElement;
      modalHeader.insertBefore(relaySelectorEl, modalHeader.querySelector('.modal__close'));
      this.relaySelector.setupEventListeners(relaySelectorEl);

      // Mount the client-tag control just before the relay selector
      // → header order: <h1>New Note</h1> | [tag icon+field] | Post to: | ×
      if (this.clientTagControl) {
        const clientTagDiv = document.createElement('div');
        clientTagDiv.innerHTML = this.clientTagControl.render();
        const clientTagEl = clientTagDiv.firstElementChild as HTMLElement;
        modalHeader.insertBefore(clientTagEl, relaySelectorEl);
        this.clientTagControl.setupEventListeners(clientTagEl);
      }
    }

    // Setup toolbar
    const toolbarContainer = modal.querySelector('.post-note-toolbar');
    if (this.toolbar && toolbarContainer) {
      this.toolbar.setupEventListeners(toolbarContainer as HTMLElement);
    }

    this.mentionAutocomplete = new MentionAutocomplete({
      textareaSelector: '[data-textarea]',
      onMentionInserted: (_npub, username) => {
        this.systemLogger.info('PostNoteModal', `Mention inserted: @${username}`);
      }
    });
    this.mentionAutocomplete.init();

    // Custom emoji shortcode autocomplete (addon-gated, lazy-loaded)
    if (isCustomEmojisEnabled()) {
      void this.initCustomEmojiAutocomplete();
    }

    this.eventHandlerManager = new ModalEventHandlerManager({
      modalSelector: '.post-note-modal',
      textareaSelector: '[data-textarea]',
      activeTabClass: 'tab--active',
      currentTab: this.currentTab,
      onTabSwitch: (tab) => this.switchTab(tab),
      onTextInput: (value) => {
        this.content = value;
        this.updatePostButton();
      },
      onCancel: () => this.handleCancel(),
      onSubmit: () => this.handlePost(),
      onSaveDraft: () => this.handleSaveDraft()
    });
    this.eventHandlerManager.setupEventListeners();

    // Paste-to-upload: a pasted image/video/audio is uploaded via the upload path.
    const textarea = modal.querySelector('[data-textarea]') as HTMLElement | null;
    if (textarea) setupPasteUpload(textarea, files => void this.toolbar?.handleFileUpload(files));
  }

  /**
   * Switch between Edit/Preview tabs
   */
  private switchTab(tab: TabMode): void {
    this.currentTab = tab;
    this.setActiveTab(tab);

    const rendered = switchComposerTab({
      modalSelector: '.post-note-modal',
      tab,
      renderEditorHtml: () => this.renderEditor(),
      onEditRendered: () => this.eventHandlerManager?.refreshTextareaListener(),
      buildPreviewHtml: () => {
        const currentUser = this.authService.getCurrentUser();
        let html = renderPostPreview({
          content: stripTrackingParams(this.content),
          pubkey: currentUser?.pubkey || '',
          isNSFW: this.isNSFW
        });
        // Add poll preview if poll is configured
        const pollPreviewHtml = this.renderPollPreview();
        if (pollPreviewHtml) html += pollPreviewHtml;
        return html;
      },
      onPreviewRendered: (previewContainer) => {
        this.renderQuotedNotesInPreview(previewContainer);
        attachPreviewClickToEdit(previewContainer, () => this.switchTab('edit'));
      },
      renderDraftsHtml: () => renderDraftsList(),
      onDraftsRendered: (draftsContainer) => setupDraftsList(draftsContainer, {
        onOpen: (draft) => {
          this.cleanup();
          this.modalService.hide();
          openDraftInComposer(draft);
        },
        onChanged: () => this.updateDraftsTabBadge(),
      }),
    });

    if (rendered) {
      // Toggle poll-creator visibility based on tab
      const pollContainer = document.querySelector('.post-note-modal #poll-creator-container') as HTMLElement;
      if (pollContainer) {
        pollContainer.style.display = this.currentTab === 'edit' ? '' : 'none';
      }
    }
  }

  /**
   * Update post button state
   */
  private updatePostButton(): void {
    if (this.highlightSource) {
      const btn = document.querySelector('[data-action="post"]') as HTMLButtonElement | null;
      if (btn) btn.disabled = this.selectedRelays.size === 0;
      return;
    }
    EditorStateManager.updatePostButton(
      '[data-action="post"]',
      this.content,
      this.selectedRelays,
      this.pollData
    );
  }

  /**
   * Update preview (used when NSFW switch changes)
   */
  private updatePreview(): void {
    const currentUser = this.authService.getCurrentUser();
    EditorStateManager.updatePreview('.post-note-preview', {
      content: stripTrackingParams(this.content),
      pubkey: currentUser?.pubkey || '',
      isNSFW: this.isNSFW
    });
  }

  /**
   * Handle media uploaded callback
   */
  private handleMediaUploaded(url: string): void {
    EditorStateManager.handleMediaUploaded(url, '[data-textarea]', {
      onContentChange: (newContent) => {
        this.content = newContent;
        this.updatePostButton();
      },
      onShowNSFWSwitch: () => this.showNSFWSwitch()
    });
    // NIP-68 image tagging — register URL in state + render thumbnail.
    // Skip non-image URLs (videos, audio) — NIP-68 is image-only.
    if (isImageUrl(url)) {
      this.imageTags.set(url, []);
      this.appendToMediaStrip(url);
    }
  }

  /**
   * Append a thumbnail + tag-button to the media-strip.
   */
  private appendToMediaStrip(url: string): void {
    const strip = document.querySelector('#post-note-media-strip');
    if (!strip) return;

    const thumb = document.createElement('div');
    thumb.className = 'post-note-modal__media-thumb';
    thumb.dataset.imageUrl = url;
    thumb.innerHTML = `
      <img class="post-note-modal__media-thumb-img" src="${escapeHtml(url)}" alt="" loading="lazy">
      <button type="button" class="post-note-modal__tag-btn" data-tag-url="${escapeHtml(url)}" title="Tag users in this image" aria-label="Tag users">
        <svg width="14" height="14"><use href="#icon-tag"/></svg>
        <span class="post-note-modal__tag-badge is-hidden" data-tag-badge>0</span>
      </button>
    `;
    strip.appendChild(thumb);

    // Wire tag-button click
    const tagBtn = thumb.querySelector('.post-note-modal__tag-btn') as HTMLElement;
    tagBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openTagOverlay(url, tagBtn);
    });
  }

  /**
   * Open the tagging overlay for a specific image.
   *
   * Toggle behaviour: if an overlay is already open for this URL, the click
   * closes it (and removes the host). Otherwise a fresh overlay is created
   * and pre-filled with the chips currently stored in `this.imageTags`.
   *
   * State survives close/reopen because chips are live-synced to
   * `this.imageTags` via `onChipsChange`. The component itself is destroyed
   * on close so outside-click / ESC / Apply all clean up identically.
   */
  private openTagOverlay(url: string, _anchorBtn: HTMLElement): void {
    // If already open for this URL, the click toggles closed.
    const existing = this.tagOverlays.get(url);
    if (existing) {
      existing.collapseSearch(); // triggers onClose → closeTagOverlay cleanup
      return;
    }

    const component = new ProfileSearchComponent({
      sizeVariant: 'compact-modal',
      triggerIconId: 'icon-tag',
      triggerTitle: 'Tag users',
      placeholder: 'Tag different users, separate by comma',
      buttonText: 'Apply',
      buttonLoadingText: 'Applying...',
      buttonClass: 'btn-small btn-passive',
      statusEnabled: false,
      privacyHint: 'Tagged users will be publicly visible',
      chipMode: true,
      initialChips: (this.imageTags.get(url) ?? []).map(e => ({ ...e })),
      onChipsChange: (chips) => {
        // Hard cap (UI guard before publish — also enforced in PostService).
        if (chips.length > PostNoteModal.MAX_TAGS_PER_IMAGE) {
          ToastService.show('Only 50 tags permitted', 'error');
          // Trim back to the cap so the user sees the limit enforced.
          const trimmed = chips.slice(0, PostNoteModal.MAX_TAGS_PER_IMAGE);
          this.imageTags.set(url, trimmed);
        } else {
          this.imageTags.set(url, chips.map(c => ({ ...c })));
        }
        this.updateTagBadge(url);

        // Async username enrichment — when a chip was added from raw npub
        // text (no MentionAutocomplete selection), its username is the
        // truncated npub. Resolve the real username in the background.
        // (No-op for chips that already have a real username.)
        void this.enrichChipUsernames(url);
      },
      onClose: () => {
        this.closeTagOverlay(url);
      },
      onSubmit: async (_value, helpers) => {
        // Chips are already synced via onChipsChange — Apply just closes.
        if ((this.imageTags.get(url) ?? []).length > PostNoteModal.MAX_TAGS_PER_IMAGE) {
          ToastService.show('Only 50 tags permitted', 'error');
          return;
        }
        helpers.collapse();
      },
    });

    // Mount next to the thumbnail
    const allThumbs = Array.from(document.querySelectorAll('.post-note-modal__media-thumb')) as HTMLElement[];
    const thumb = allThumbs.find(t => t.dataset.imageUrl === url);
    if (!thumb) return;
    const host = document.createElement('div');
    host.className = 'post-note-modal__tag-overlay-host';
    host.appendChild(component.getElement());
    thumb.appendChild(host);
    component.expandSearch();

    // Wire MentionAutocomplete to the component's input. When the user
    // picks a suggestion, cache the username so the chip created from
    // Enter/comma later shows the proper name instead of a truncated npub.
    const inputEl = component.getElement().querySelector('.textinput-overlay__input') as HTMLInputElement | null;
    if (inputEl) {
      inputEl.setAttribute('data-image-tags', url);
      const autocomplete = new MentionAutocomplete({
        textareaSelector: `[data-image-tags]`,
        onMentionInserted: (npub, username) => {
          // Convert the mention directly into a chip — the user never sees
          // the raw `nostr:npub1...` text in the input.
          component.addChipFromMention(npub, username);
        },
      });
      autocomplete.init();
      this.tagMentionAutocompletes.set(url, autocomplete);
    }

    this.tagOverlays.set(url, component);
  }

  /**
   * Teardown for a single image-tag overlay — destroys the component, drops
   * it from the maps, removes the host element. Triggered by the component's
   * onClose callback (fires on ESC, outside-click, Apply via helpers.collapse,
   * and the toggle branch of openTagOverlay).
   */
  private closeTagOverlay(url: string): void {
    const component = this.tagOverlays.get(url);
    if (component) {
      component.destroy();
      this.tagOverlays.delete(url);
    }
    const autocomplete = this.tagMentionAutocompletes.get(url);
    if (autocomplete) {
      autocomplete.destroy();
      this.tagMentionAutocompletes.delete(url);
    }
    // Remove the host (and its DOM subtree) from the thumbnail.
    const allThumbs = Array.from(document.querySelectorAll('.post-note-modal__media-thumb')) as HTMLElement[];
    const thumb = allThumbs.find(t => t.dataset.imageUrl === url);
    thumb?.querySelector('.post-note-modal__tag-overlay-host')?.remove();
  }

  /**
   * Background-pass: resolve real usernames for chips whose `username` is
   * still the truncated-npub fallback. Mutates `this.imageTags` in place
   * and updates chip DOM if the overlay is still open.
   */
  private async enrichChipUsernames(url: string): Promise<void> {
    const entries = this.imageTags.get(url);
    if (!entries || entries.length === 0) return;

    await Promise.all(entries.map(async (entry) => {
      // Only enrich chips that still show the truncated-npub fallback.
      if (!entry.username.endsWith('…')) return;
      const real = await this.usernameFromPubkey(entry.pubkey);
      if (real) entry.username = real;
    }));

    // Update chip DOM if the overlay is still open.
    const component = this.tagOverlays.get(url);
    if (component) {
      const chipNames = component.getElement().querySelectorAll('.textinput-overlay__chip-name');
      chipNames.forEach((el, i) => {
        if (entries[i]) el.textContent = entries[i].username;
      });
    }
  }

  /**
   * Update the count badge on a thumbnail after tag changes.
   */
  private updateTagBadge(url: string): void {
    const allBtns = Array.from(document.querySelectorAll('.post-note-modal__tag-btn')) as HTMLElement[];
    const btn = allBtns.find(b => b.dataset.tagUrl === url);
    if (!btn) return;
    const badge = btn.querySelector('[data-tag-badge]') as HTMLElement;
    if (!badge) return;
    const count = this.imageTags.get(url)?.length ?? 0;
    if (count > 0) {
      badge.textContent = String(count);
      badge.classList.remove('is-hidden');
    } else {
      badge.classList.add('is-hidden');
    }
  }

  /**
   * Async username lookup via UserProfileService.
   */
  private async usernameFromPubkey(hex: string): Promise<string | null> {
    try {
      const profile = await UserProfileService.getInstance().getUserProfile(hex);
      return profile?.name || profile?.display_name || null;
    } catch {
      return null;
    }
  }

  /**
   * Handle emoji selected callback
   */
  private handleEmojiSelected(emoji: string): void {
    EditorStateManager.handleEmojiSelected(emoji, '[data-textarea]', {
      onContentChange: (newContent) => {
        this.content = newContent;
        this.updatePostButton();
      }
    });
  }

  /**
   * Show NSFW switch after media upload
   */
  private showNSFWSwitch(): void {
    // Don't create switch if it already exists
    if (this.nsfwSwitch) return;

    const optionsContainer = document.querySelector('#post-note-options-container');
    if (!optionsContainer) return;

    // Create NSFW switch component
    this.nsfwSwitch = new Switch({
      label: 'NSFW',
      checked: this.isNSFW,
      onChange: (checked) => {
        this.isNSFW = checked;
        // Re-render preview if currently in preview tab
        if (this.currentTab === 'preview') {
          this.updatePreview();
        }
      }
    });

    // Insert switch into DOM
    optionsContainer.innerHTML = this.nsfwSwitch.render();
    this.nsfwSwitch.setupEventListeners(optionsContainer as HTMLElement);
  }

  /**
   * Handle poll toggle
   */
  private handlePollToggle(): void {
    const pollContainer = document.querySelector('#poll-creator-container');
    if (!pollContainer) return;

    // Toggle poll creator
    if (this.pollCreator) {
      // Remove poll
      this.pollCreator.destroy();
      this.pollCreator = null;
      this.pollData = null;
      pollContainer.innerHTML = '';
      this.updatePostButton();
    } else {
      // Add poll
      this.pollCreator = new PollCreator({
        onPollDataChange: (data) => {
          if (data === null) {
            // Remove poll requested
            this.pollCreator?.destroy();
            this.pollCreator = null;
            this.pollData = null;
            pollContainer.innerHTML = '';
          } else {
            this.pollData = data;
          }
          // Update post button state when poll data changes
          this.updatePostButton();
        }
      });

      pollContainer.innerHTML = this.pollCreator.render();
      this.pollCreator.setupEventListeners(pollContainer as HTMLElement);
    }
  }

  /**
   * Handle cancel button click
   */
  private handleCancel(): void {
    // Route through the same unsaved-content guard as ESC / Back / the close
    // button so every dismiss path behaves identically. When the guard defers
    // (dirty note), askSaveDraftThenClose() owns the cleanup + hide.
    if (this.confirmDiscardOrSave()) {
      this.cleanup();
      this.modalService.hide();
    }
  }

  /**
   * Guard for every user-initiated dismiss (Cancel / ESC / Back / close button).
   * Returns true to allow an immediate close (highlight mode or an empty composer
   * have nothing to save). For a dirty regular note it vetoes the immediate close
   * and asks "Save as draft?" on the next microtask, so the composer tears down
   * first and frees the shared ModalService container for the confirm dialog.
   */
  private confirmDiscardOrSave(): boolean {
    if (this.highlightSource) return true;
    const textarea = document.querySelector('.post-note-modal [data-textarea]') as HTMLTextAreaElement | null;
    const content = (textarea ? textarea.value : this.content).trim();
    if (!content) return true;
    queueMicrotask(() => void this.askSaveDraftThenClose(content));
    return false;
  }

  /**
   * Close the composer, then ask whether to keep the unsent note as a draft.
   * Yes → persist via NoteDraftService; No (incl. ESC on the dialog) → discard.
   */
  private async askSaveDraftThenClose(content: string): Promise<void> {
    this.cleanup();
    this.modalService.hide();
    const save = await this.modalService.confirm({
      title: 'Save as draft?',
      message: 'Keep this unsent note in your drafts?',
      confirmText: 'Yes',
      cancelText: 'No',
    });
    if (save) {
      NoteDraftService.getInstance().add({ type: 'note', content, failed: false });
      ToastService.show('Draft saved', 'success');
    }
  }

  /**
   * Handle post button click
   */
  private async handlePost(): Promise<void> {
    if (this.highlightSource) {
      await this.handlePostHighlight();
      return;
    }

    const validation = ContentValidationManager.validate({
      content: this.content,
      selectedRelays: this.selectedRelays,
      pollData: this.pollData
    });

    if (!validation.isValid) return;
    if (!AuthGuard.requireAuth('create a post')) return;

    this.toolbar?.hideEmojiPicker();

    const modalContainer = document.querySelector('.modal') as HTMLElement;
    let originalDisplay = '';
    if (modalContainer) {
      originalDisplay = modalContainer.style.display;
      modalContainer.style.display = 'none';
    }

    const postLabel = this.scheduledAt !== null ? 'Schedule' : 'Post';
    const loadingId = ToastService.loading('Waiting for signer approval…');
    try {
      const quotedRefs = extractQuotedReferences(this.content);
      let quotedEvent: { eventId: string; authorPubkey: string; relayHint?: string } | undefined;
      let quotedArticle: { addressableId: string; authorPubkey: string; relayHint?: string } | undefined;

      const ref = quotedRefs[0];
      if (ref) {
        const cleanRef = ref.id.replace(/^nostr:/, '');

        try {
          const decoded = decodeNip19(cleanRef);

          if (decoded.type === 'nevent') {
            const neventData = decoded.data as { id: string; author?: string; relays?: string[] };
            const relayHint = neventData.relays?.[0];
            quotedEvent = {
              eventId: neventData.id,
              authorPubkey: neventData.author || '',
              ...(relayHint ? { relayHint } : {})
            };
          } else if (decoded.type === 'naddr') {
            const naddrData = decoded.data as { kind: number; pubkey: string; identifier: string; relays?: string[] };
            const addressableId = `${naddrData.kind}:${naddrData.pubkey}:${naddrData.identifier}`;
            const relayHint = naddrData.relays?.[0];
            quotedArticle = {
              addressableId,
              authorPubkey: naddrData.pubkey,
              ...(relayHint ? { relayHint } : {})
            };
          }
        } catch (error) {
          console.warn('Failed to decode quoted reference:', error);
        }
      }

      const clientTag = this.customClientTag.trim();

      let success: boolean;
      if (this.scheduledAt !== null && isScheduledPostsEnabled()) {
        const { scheduleNote } = await import('../../addons/scheduled-posts/scheduleNote');
        success = await scheduleNote({
          content: this.content,
          relays: Array.from(this.selectedRelays),
          contentWarning: this.isNSFW,
          ...(this.pollData ? { pollData: this.pollData } : {}),
          ...(quotedEvent ? { quotedEvent } : {}),
          ...(quotedArticle ? { quotedArticle } : {}),
          ...(clientTag ? { clientTag } : {}),
          scheduledAt: this.scheduledAt,
        });
      } else {
        // Build optional imageTags payload from the per-URL state. Skip empty
        // entries and the whole field when nothing is tagged (keeps legacy
        // notes byte-identical to before NIP-68 support).
        const imageTagsPayload = Array.from(this.imageTags.entries())
          .filter(([, tags]) => tags.length > 0)
          .map(([imageUrl, tags]) => ({
            imageUrl,
            taggedPubkeys: tags.map(t => t.pubkey),
          }));

        success = await this.postsApi?.createPost({
          content: this.content,
          relays: Array.from(this.selectedRelays),
          contentWarning: this.isNSFW,
          ...(this.pollData ? { pollData: this.pollData } : {}),
          ...(quotedEvent ? { quotedEvent } : {}),
          ...(quotedArticle ? { quotedArticle } : {}),
          ...(clientTag ? { clientTag } : {}),
          ...(imageTagsPayload.length > 0 ? { imageTags: imageTagsPayload } : {}),
        }) ?? false;
      }

      ToastService.dismiss(loadingId);

      if (success) {
        if (quotedEvent?.eventId) {
          ModuleLoader.getInstance().getApi<ReactionsModuleApi>('reactions')?.clearCacheOnly(quotedEvent.eventId);
        }
        if (quotedArticle?.addressableId) {
          ModuleLoader.getInstance().getApi<ReactionsModuleApi>('reactions')?.clearCacheOnly(quotedArticle.addressableId);
        }

        this.cleanup();
        this.modalService.hide();
        this.systemLogger.success('PostService', 'Note posted successfully');
      } else {
        this.handlePostFailure(modalContainer, originalDisplay, postLabel);
      }
    } catch (error) {
      ToastService.dismiss(loadingId);
      this.handlePostFailure(modalContainer, originalDisplay, postLabel, error);
    }
  }

  /**
   * Save the current composer content as a manual draft.
   */
  private handleSaveDraft(): void {
    const textarea = document.querySelector('.post-note-modal [data-textarea]') as HTMLTextAreaElement | null;
    const content = (textarea ? textarea.value : this.content).trim();
    if (!content) {
      ToastService.show('Nothing to save', 'info');
      return;
    }
    NoteDraftService.getInstance().add({ type: 'note', content, failed: false });
    ToastService.show('Draft saved', 'success');
    this.updateDraftsTabBadge();
  }

  /**
   * A post could not be signed/published: save it as a failed draft, restore
   * the composer, and offer a one-tap path into the Drafts tab.
   */
  private handlePostFailure(
    modalContainer: HTMLElement | null,
    originalDisplay: string,
    label: string,
    error?: unknown
  ): void {
    const reason = error instanceof SignerTimeoutError
      ? 'Signer did not respond in time'
      : (error instanceof Error && error.message ? error.message : 'Note could not be published');

    NoteDraftService.getInstance().add({
      type: 'note',
      content: this.content,
      failed: true,
      failureReason: reason,
    });

    ModalEventHandlerManager.restoreAfterError(modalContainer, originalDisplay, label);
    this.updateDraftsTabBadge();

    ToastService.showWithAction(`Failed to post: ${reason}`, 'error', {
      label: 'Open drafts',
      onClick: () => this.switchTab('drafts'),
    });
  }

  /**
   * Publish a NIP-84 Highlight (kind 9802). Content = the verbatim quote;
   * the textarea contents become the optional `comment` tag.
   */
  private async handlePostHighlight(): Promise<void> {
    if (!this.highlightSource) return;
    if (this.selectedRelays.size === 0) return;
    if (!AuthGuard.requireAuth('post a highlight')) return;

    this.toolbar?.hideEmojiPicker();

    const modalContainer = document.querySelector('.modal') as HTMLElement;
    let originalDisplay = '';
    if (modalContainer) {
      originalDisplay = modalContainer.style.display;
      modalContainer.style.display = 'none';
    }

    try {
      const success = await this.postsApi?.createHighlight({
        highlightedText: this.highlightSource.selectedText,
        comment: this.content,
        sourceEvent: this.highlightSource.event,
        relays: Array.from(this.selectedRelays)
      });

      if (success) {
        this.highlightSource = null;
        this.cleanup();
        this.modalService.hide();
      } else {
        ModalEventHandlerManager.restoreAfterError(modalContainer, originalDisplay, 'Post Highlight');
      }
    } catch (error) {
      console.error('Highlight post error:', error);
      ModalEventHandlerManager.restoreAfterError(modalContainer, originalDisplay, 'Post Highlight');
    }
  }

  /**
   * Render quoted notes in preview
   */
  private async renderQuotedNotesInPreview(container: HTMLElement): Promise<void> {
    const quotedRefs = extractQuotedReferences(this.content);
    if (quotedRefs.length === 0) return;

    const markers = container.querySelectorAll('.quote-marker');

    for (let i = 0; i < Math.min(quotedRefs.length, markers.length); i++) {
      const ref = quotedRefs[i];
      const marker = markers[i];

      if (ref && marker) {
        try {
          const quotePreview = await renderQuotePreview(ref.id);
          marker.replaceWith(quotePreview);
        } catch (error) {
          console.error('Failed to render quote preview:', error);
        }
      }
    }
  }

  /**
   * Render poll preview for Preview tab
   */
  private renderPollPreview(): string {
    if (!this.pollData) return '';

    const validOptions = this.pollData.options.filter(o => o.label.trim());
    if (validOptions.length < 2) return '';

    const metaItems: string[] = [];
    if (this.pollData.multipleChoice) {
      metaItems.push('<span class="nip88-poll__meta-item">Multiple choice allowed</span>');
    }
    if (this.pollData.endDate) {
      const endDate = new Date(this.pollData.endDate * 1000);
      metaItems.push(`<span class="nip88-poll__meta-item">Ends ${endDate.toLocaleDateString()}</span>`);
    }
    const metaHtml = metaItems.length > 0
      ? `<div class="nip88-poll__meta">${metaItems.join('')}</div>`
      : '';

    const optionsHtml = validOptions.map(option => `
      <div class="nip88-poll__option nip88-poll__option--preview">
        <span class="nip88-poll__option-label">${escapeHtml(option.label)}</span>
        <span class="nip88-poll__option-stats">
          <span class="nip88-poll__option-count">0 votes</span>
          <span class="nip88-poll__option-percentage">0%</span>
        </span>
        <span class="nip88-poll__option-bar" style="width: 0%"></span>
      </div>
    `).join('');

    return `
      <div class="nip88-poll nip88-poll--preview">
        ${metaHtml}
        <div class="nip88-poll__options">
          ${optionsHtml}
        </div>
      </div>
    `;
  }


  /**
   * Cleanup sub-components
   */
  private cleanup(): void {
    this.relaySelector?.destroy();
    this.relaySelector = null;

    this.clientTagControl?.destroy();
    this.clientTagControl = null;

    this.toolbar?.destroy();
    this.toolbar = null;

    this.nsfwSwitch?.destroy();
    this.nsfwSwitch = null;

    this.pollCreator?.destroy();
    this.pollCreator = null;

    this.mentionAutocomplete?.destroy();
    this.mentionAutocomplete = null;

    // NIP-68 image-tagging state
    this.tagOverlays.forEach(c => c.destroy());
    this.tagOverlays.clear();
    this.tagMentionAutocompletes.forEach(a => a.destroy());
    this.tagMentionAutocompletes.clear();
    this.imageTags.clear();

    this.customEmojiAutocomplete?.destroy();
    this.customEmojiAutocomplete = null;
    this.customEmojiService = null;

    this.pollData = null;
    this.scheduledAt = null;
    this.highlightSource = null;
  }

  /**
   * Lazy-load the custom emoji autocomplete and attach it to the textarea.
   * Only invoked when the Custom Emojis addon is enabled.
   */
  private async initCustomEmojiAutocomplete(): Promise<void> {
    try {
      const [{ CustomEmojiAutocomplete }, { EmojiService }] = await Promise.all([
        import('../../addons/custom-emojis/CustomEmojiAutocomplete'),
        import('../../addons/custom-emojis/EmojiService'),
      ]);
      this.customEmojiService = EmojiService.getInstance();
      this.customEmojiAutocomplete = new CustomEmojiAutocomplete({
        textareaSelector: '[data-textarea]',
        onEmojiInserted: (shortcode) => {
          this.systemLogger.info('PostNoteModal', `Custom emoji inserted: :${shortcode}:`);
        }
      });
      this.customEmojiAutocomplete.init();
    } catch (err) {
      this.systemLogger.warn('PostNoteModal', `Custom emoji autocomplete load failed: ${err}`);
    }
  }

  /**
   * Sync helper: scan the current content for `:shortcode:` and return matching
   * NIP-30 emoji tags. Used by the Preview tab so animated GIFs render inline.
   */
  private buildPreviewEmojiTags(content: string): string[][] {
    if (!this.customEmojiService) return [];
    const tags: string[][] = [];
    const seen = new Set<string>();
    const re = /:([a-zA-Z0-9_-]+):/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const code = m[1]!;
      if (seen.has(code)) continue;
      seen.add(code);
      const emoji = this.customEmojiService.findEmoji(code);
      if (emoji) tags.push(['emoji', code, emoji.url]);
    }
    return tags;
  }
}
