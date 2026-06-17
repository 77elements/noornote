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
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export interface HighlightSource {
  /** The selected text passage (verbatim quote of source) */
  selectedText: string;
  /** The source event being highlighted */
  event: NostrEvent;
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
  private draftContent: string = '';
  private isNSFW: boolean = false;
  private pollData: PollData | null = null;
  private scheduledAt: number | null = null;
  private highlightSource: HighlightSource | null = null;

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
    // In Highlight mode the textarea is the comment (start empty, no draft reuse).
    this.content = this.highlightSource
      ? (initialContent ?? '')
      : (initialContent ?? this.draftContent);
    this.loadRelayConfiguration();

    const modalContent = this.renderContent();

    this.modalService.show({
      title: this.highlightSource ? 'New Highlight' : 'New Note',
      content: modalContent,
      width: '650px',
      height: 'auto',
      showCloseButton: true,
      closeOnOverlay: false,
      closeOnEsc: true
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
    // Don't carry an unfinished highlight comment over into the next regular
    // note's draft — that text was meant for a specific source.
    if (!this.highlightSource) {
      const textarea = document.querySelector('[data-textarea]') as HTMLTextAreaElement;
      this.draftContent = textarea ? textarea.value : this.content;
    }

    this.cleanup();
    this.modalService.hide();
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
          scheduledAt: this.scheduledAt,
        });
      } else {
        success = await this.postsApi?.createPost({
          content: this.content,
          relays: Array.from(this.selectedRelays),
          contentWarning: this.isNSFW,
          ...(this.pollData ? { pollData: this.pollData } : {}),
          ...(quotedEvent ? { quotedEvent } : {}),
          ...(quotedArticle ? { quotedArticle } : {})
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

        this.draftContent = '';
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
        this.draftContent = '';
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

    this.toolbar?.destroy();
    this.toolbar = null;

    this.nsfwSwitch?.destroy();
    this.nsfwSwitch = null;

    this.pollCreator?.destroy();
    this.pollCreator = null;

    this.mentionAutocomplete?.destroy();
    this.mentionAutocomplete = null;

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
