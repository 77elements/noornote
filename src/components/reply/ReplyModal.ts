/**
 * ReplyModal Component
 * Modal dialog for creating replies (Kind 1, NIP-10) or comments (Kind 1111, NIP-22)
 *
 * Features:
 * - Shows parent note context above reply editor
 * - Edit/Preview tabs
 * - Comment/Reply switch for kind:1 parent events (NIP-22)
 * - Multi-relay selector (TEST mode = local relay only)
 * - Content preview with ContentProcessor
 * - Publish reply with proper tags via PostService
 *
 * NIP-22 Comment Mode (kind:1111):
 * - Comment stays under the original post, doesn't appear on author's profile
 * - Forced for non-kind:1 parent events (articles, etc.)
 * - Optional for kind:1 parent events (user choice via switch)
 *
 * NIP-10 Reply Mode (kind:1):
 * - Reply appears on author's profile and in followers' feeds
 * - Only available for kind:1 parent events
 */

import { _ } from '../../i18n';
import { LazyModuleApi } from '../../core/LazyModuleApi';
import { ModalService } from '../../services/ModalService';
import type { PostsModuleApi } from '../../modules/posts/contracts';
import type { GifItem } from '../../services/GifSearchService';
import { RelayConfig } from '../../services/RelayConfig';
import { loadEditorRelayConfig } from '../../helpers/editorRelayConfig';
import { switchComposerTab } from '../../helpers/switchComposerTab';
import { SystemLogger } from '../../services/SystemLogger';
import { AuthService } from '../../services/AuthService';
import { RelaySelector } from '../post/RelaySelector';
import { setupPasteUpload } from '../../helpers/pasteUpload';
import { Switch } from '../ui/Switch';
import type { ReactionsModuleApi } from '../../modules/reactions/contracts';
import { AppState } from '../../services/AppState';
import { TypedEventBus } from '../../core/TypedEventBus';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { NoteUI } from '../ui/NoteUI';
import { ZapReceiptRenderer } from '../ui/note-rendering/ZapReceiptRenderer';
import { ContentValidationManager } from '../post/ContentValidationManager';
import { EditorStateManager } from '../post/EditorStateManager';
import { isCustomEmojisEnabled } from '../../addons/custom-emojis/index';
import { type TabMode } from '../modals/ModalEventHandlerManager';
import {
  ComposerControls,
  runComposerPublish,
  createComposerToolbar,
  composerEditorEditHtml,
  composerInsertMedia,
  composerInsertEmoji,
  composerDraftsTabLabel,
  updateComposerDraftsBadge,
  setComposerActiveTab,
  saveComposerDraft,
  composerPostFailure,
  renderQuotedNotesInPreview as fillQuotedPreviewMarkers,
  buildComposerPreviewHtml,
  renderComposerPreviewContent,
  updateComposerPreview,
  createNsfwSwitchIn,
  mountRelaySelectorInHeader,
  loadComposerEmojiAutocomplete,
  scanComposerEmojiShortcodes,
  createMentionAutocomplete,
  composerDraftsPanel,
  createComposerEventHandlers,
} from '../post/composerShared';
import { openDraftInComposer } from '../../helpers/draftRouter';
import { attachPreviewClickToEdit } from '../../helpers/previewClickToEdit';

export class ReplyModal {
  private static instance: ReplyModal;
  private modalService: ModalService;
  private postsApi = new LazyModuleApi<PostsModuleApi>('posts');
  private relayConfig: RelayConfig;
  private authService: AuthService;
  private systemLogger: SystemLogger;
  private appState: AppState;
  private reactionsApi = new LazyModuleApi<ReactionsModuleApi>('reactions');
  private eventBus: TypedEventBus;

  // Sub-components (shared teardown — see ComposerControls.destroy)
  private controls = new ComposerControls();
  private commentSwitch: Switch | null = null;

  // State
  private currentTab: TabMode = 'edit';
  private content: string = '';
  private selectedRelays: Set<string> = new Set();
  private availableRelays: string[] = [];
  private isTestMode: boolean = false;
  private isNSFW: boolean = false;
  private isComment: boolean = true;
  private parentEvent: NostrEvent | null = null;

  private constructor() {
    this.modalService = ModalService.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.authService = AuthService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.appState = AppState.getInstance();
    this.eventBus = TypedEventBus.getInstance();
  }

  public static getInstance(): ReplyModal {
    if (!ReplyModal.instance) {
      ReplyModal.instance = new ReplyModal();
    }
    return ReplyModal.instance;
  }

  /**
   * Check if parent event is kind:1 (only then user gets a choice)
   */
  private get parentIsKind1(): boolean {
    return this.parentEvent?.kind === 1 || this.parentEvent?.kind === undefined;
  }

  /**
   * Show the reply modal
   * @param parentNoteId - ID of the note being replied to
   * @param parentEvent - Optional: Parent event (avoids cache lookup/fetch)
   */
  public async show(
    parentNoteId: string,
    parentEvent?: NostrEvent,
    initialContent?: string
  ): Promise<void> {
    // If parent event not provided, fetch from relays
    if (!parentEvent) {
      this.systemLogger.info(
        'ReplyModal',
        `Fetching parent event from relays...`
      );
      const fetchedEvent = await this.fetchParentEvent(parentNoteId);

      if (!fetchedEvent) {
        this.systemLogger.error(
          'ReplyModal',
          `Parent event not found: ${parentNoteId}`
        );
        return;
      }
      parentEvent = fetchedEvent;
    }

    this.parentEvent = parentEvent;
    this.currentTab = 'edit';
    this.content = initialContent ?? '';
    // Default: Reply (kind:1) for kind:1 parents, Comment (kind:1111) for everything else
    this.isComment = !this.parentIsKind1;
    this.loadRelayConfiguration();

    const modalContent = this.renderContent();

    this.modalService.show({
      title: _('Reply'),
      content: modalContent,
      width: '700px',
      height: 'auto',
      showCloseButton: true,
      closeOnOverlay: false,
      closeOnEsc: true,
    });

    setTimeout(() => {
      this.setupEventHandlers();
    }, 0);
  }

  /**
   * Fetch parent event from relays (fallback when not in cache)
   */
  private async fetchParentEvent(noteId: string): Promise<NostrEvent | null> {
    const { fetchNostrEvents } = await import(
      '../../services/FetchNostrEvents'
    );
    const relays = this.relayConfig.getReadRelays();

    const result = await fetchNostrEvents({
      relays,
      ids: [noteId],
      limit: 1,
    });

    if (result.events.length === 0) {
      return null;
    }

    return result.events[0] ?? null;
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
      this.systemLogger.info('ReplyModal', 'TEST mode: Using local relay only');
      return;
    }

    // Relay-filtered timeline active → pre-select only that relay (on top of base).
    const selectedRelay = this.appState.getState('timeline').selectedRelay;
    if (selectedRelay) {
      this.selectedRelays = new Set([selectedRelay]);
      this.systemLogger.info(
        'ReplyModal',
        `Relay filter active: Pre-selecting ${selectedRelay}`
      );
    } else {
      this.systemLogger.info(
        'ReplyModal',
        `Normal mode: ${this.availableRelays.length} relays available`
      );
    }
  }

  /**
   * Render modal content
   */
  private renderContent(): string {
    return `
      <div class="reply-modal">
        ${this.renderParentNote()}
        <div class="reply-modal-editor">
          ${this.renderTabs()}
          ${this.renderEditor()}
          ${this.renderActions()}
        </div>
      </div>
    `;
  }

  /**
   * Render parent note context (above reply editor)
   */
  private renderParentNote(): string {
    if (!this.parentEvent) return '';

    // Empty mount container; the live note node is appended in setupEventHandlers().
    // Serializing to outerHTML would detach the async quote/media upgrades from the
    // visible DOM, leaving embedded quotes stuck as skeletons.
    return `
      <div class="reply-modal-parent">
        <div class="reply-modal-parent-note" data-parent-mount></div>
      </div>
    `;
  }

  /**
   * Mount the live parent note node (with header, without ISL) into its container.
   * Must use the live HTMLElement so NoteUI's async quote/media upgrades resolve
   * in the visible modal DOM.
   */
  private mountParentNote(modal: Element): void {
    if (!this.parentEvent) return;
    const mount = modal.querySelector('[data-parent-mount]');
    if (!mount) return;

    const noteElement = NoteUI.createNoteElement(this.parentEvent, {
      collapsible: false,
      islFetchStats: false,
      isLoggedIn: false,
      headerSize: 'medium',
      depth: 0,
      zapReceiptClickable: false,
    });
    mount.appendChild(noteElement);

    // Zap-receipt parent: replace the plain sender→recipient line with the
    // reaction line ("💜 Cody → alp") — same display as the receipt card in
    // the SNV. Shared detailed-stats cache (the zaps-list pill hints batch-
    // fetch the same receipt ids).
    if (this.parentEvent.kind === 9735 && this.parentEvent.id) {
      const card = noteElement.matches('.note-card--zap-receipt')
        ? noteElement
        : noteElement.querySelector('.note-card--zap-receipt');
      const receiptId = this.parentEvent.id;
      if (card) {
        void this.reactionsApi
          .get()
          ?.getDetailedStats(receiptId)
          .then(stats => {
            if (stats && stats.reactionEvents.length > 0) {
              ZapReceiptRenderer.updateReactions(
                card as HTMLElement,
                stats.reactionEvents
              );
            }
          })
          .catch(() => undefined);
      }
    }
  }

  /**
   * Render tabs header (Edit/Preview + Comment Switch + Relay Selector)
   */
  private renderTabs(): string {
    // Create relay selector component
    this.controls.relaySelector = new RelaySelector({
      availableRelays: this.availableRelays,
      selectedRelays: this.selectedRelays,
      isTestMode: this.isTestMode,
      onChange: selectedRelays => {
        this.selectedRelays = selectedRelays;
        this.updatePostButton();
      },
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
    return composerDraftsTabLabel();
  }

  /**
   * Refresh the Drafts tab count badge in place.
   */
  private updateDraftsTabBadge(): void {
    updateComposerDraftsBadge('.reply-modal');
  }

  /**
   * Toggle the tab--active class across the composer tabs.
   */
  private setActiveTab(tab: TabMode): void {
    setComposerActiveTab('.reply-modal', tab);
  }

  /**
   * Render editor/preview area
   */
  private renderEditor(): string {
    if (this.currentTab === 'edit') {
      return composerEditorEditHtml({
        content: this.content,
        placeholder: _('Write your reply...'),
      });
    } else {
      const currentUser = this.authService.getCurrentUser();
      return renderComposerPreviewContent(
        this.content,
        this.isNSFW,
        currentUser?.pubkey || '',
        cleaned => this.buildPreviewEmojiTags(cleaned)
      );
    }
  }

  /**
   * Render action buttons
   */
  private renderActions(): string {
    // Create toolbar component
    this.controls.toolbar = createComposerToolbar({
      onMediaUploaded: url => this.handleMediaUploaded(url),
      onEmojiSelected: emoji => this.handleEmojiSelected(emoji),
      onGifSelected: gif => this.handleGifSelected(gif),
      textareaSelector: '[data-textarea]',
      showPoll: false, // No polls in replies
    });

    // Check if reply can be submitted (content + relays)
    const validation = ContentValidationManager.validate({
      content: this.content,
      selectedRelays: this.selectedRelays,
    });
    const isPostDisabled = !validation.isValid;
    const buttonLabel = _('Reply');

    return `
      <div class="l-row l-row--split">
        <div>
          ${this.controls.toolbar.render()}
          <div class="post-note-options" id="reply-note-options-container"></div>
        </div>
        <div>
          <button class="btn btn--passive" data-action="save-draft">${_('Save draft')}</button>
          <button class="btn btn--passive" data-action="cancel">${_('Cancel')}</button>
          <button class="btn" data-action="post" ${isPostDisabled ? 'disabled' : ''}>${buttonLabel}</button>
        </div>
      </div>
    `;
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    const modal = document.querySelector('.reply-modal');
    if (!modal) return;

    // Mount the live parent note node (resolves embedded quotes/media in place)
    this.mountParentNote(modal);

    // Mount relay selector into modal__header (outside overflow container)
    if (this.controls.relaySelector) {
      mountRelaySelectorInHeader(modal, this.controls.relaySelector);
    }

    // Setup toolbar
    const toolbarContainer = modal.querySelector('.post-note-toolbar');
    if (this.controls.toolbar && toolbarContainer) {
      this.controls.toolbar.setupEventListeners(
        toolbarContainer as HTMLElement
      );
    }

    // Paste-to-upload: pasted media goes through the same upload path as the button.
    const pasteTarget = modal.querySelector(
      '[data-textarea]'
    ) as HTMLElement | null;
    if (pasteTarget)
      setupPasteUpload(
        pasteTarget,
        files => void this.controls.toolbar?.handleFileUpload(files)
      );

    // Setup Comment/Reply switch (only for kind:1 parents)
    if (this.parentIsKind1) {
      this.setupCommentSwitch();
    }

    // Setup mention autocomplete
    this.controls.mentionAutocomplete = createMentionAutocomplete('ReplyModal');

    // Custom emoji shortcode autocomplete (addon-gated, lazy-loaded)
    if (isCustomEmojisEnabled()) {
      void this.initCustomEmojiAutocomplete();
    }

    // Setup event handler manager (tab switching, textarea, action buttons)
    this.controls.eventHandlerManager = createComposerEventHandlers({
      modalSelector: '.reply-modal',
      currentTab: this.currentTab,
      onTabSwitch: tab => this.switchTab(tab),
      onTextInput: value => {
        this.content = value;
        this.updatePostButton();
      },
      onCancel: () => this.handleCancel(),
      onSubmit: () => this.handlePost(),
      onSaveDraft: () => this.handleSaveDraft(),
    });
  }

  /**
   * Setup Comment/Reply switch with hint text
   */
  private setupCommentSwitch(): void {
    const modal = document.querySelector('.reply-modal');
    const editor = modal?.querySelector('.textarea, .post-note-preview');
    if (!modal || !editor) return;

    // Switch ON = show in timeline (Kind:1), Switch OFF = hide from timeline (Kind:1111)
    this.commentSwitch = new Switch({
      label: _('Show in my timeline'),
      checked: !this.isComment,
      onChange: checked => {
        this.isComment = !checked;
        this.updatePostButton();
      },
    });

    const switchContainer = document.createElement('div');
    switchContainer.id = 'timeline-switch-container';
    switchContainer.className = 'reply-modal-timeline-switch';
    switchContainer.innerHTML = this.commentSwitch.render();
    editor.parentNode?.insertBefore(switchContainer, editor);
    this.commentSwitch.setupEventListeners(switchContainer);
  }

  /**
   * Switch between Edit/Preview tabs
   */
  private switchTab(tab: TabMode): void {
    this.currentTab = tab;
    this.setActiveTab(tab);

    switchComposerTab({
      modalSelector: '.reply-modal',
      tab,
      renderEditorHtml: () => this.renderEditor(),
      onEditRendered: () =>
        this.controls.eventHandlerManager?.refreshTextareaListener(),
      buildPreviewHtml: () => {
        const currentUser = this.authService.getCurrentUser();
        return buildComposerPreviewHtml(
          this.content,
          this.isNSFW,
          currentUser?.pubkey || '',
          cleaned => this.buildPreviewEmojiTags(cleaned)
        );
      },
      onPreviewRendered: previewContainer => {
        void this.renderQuotedNotesInPreview(previewContainer);
        attachPreviewClickToEdit(previewContainer, () =>
          this.switchTab('edit')
        );
      },
      ...composerDraftsPanel({
        onOpen: draft => {
          this.cleanup();
          this.modalService.hide();
          openDraftInComposer(draft);
        },
        onChanged: () => this.updateDraftsTabBadge(),
      }),
    });
  }

  /**
   * Update post button state
   */
  private updatePostButton(): void {
    const btn = document.querySelector('[data-action="post"]');
    if (btn) {
      btn.textContent = _('Reply');
    }
    EditorStateManager.updatePostButton(
      '[data-action="post"]',
      this.content,
      this.selectedRelays
    );
    const btnAfter = document.querySelector('[data-action="post"]');
    if (btnAfter && btnAfter.textContent !== _('Reply')) {
      btnAfter.textContent = _('Reply');
    }
  }

  /**
   * Update preview (used when NSFW switch changes)
   */
  private updatePreview(): void {
    const currentUser = this.authService.getCurrentUser();
    updateComposerPreview(
      this.content,
      this.isNSFW,
      currentUser?.pubkey || '',
      cleaned => this.buildPreviewEmojiTags(cleaned)
    );
  }

  /**
   * Handle media uploaded callback
   */
  private handleMediaUploaded(url: string): void {
    composerInsertMedia({
      textareaSelector: '[data-textarea]',
      url,
      onContentChange: newContent => {
        this.content = newContent;
        this.updatePostButton();
      },
      onShowNSFWSwitch: () => this.showNSFWSwitch(),
    });
  }

  /**
   * GIF picked from the gifs.nostr.build picker — same insertion as uploads.
   * The publish-time imeta comes from the GIF meta cache (PostService).
   */
  private handleGifSelected(gif: GifItem): void {
    this.handleMediaUploaded(gif.url);
  }

  /**
   * Handle emoji selected callback
   */
  private handleEmojiSelected(emoji: string): void {
    composerInsertEmoji({
      textareaSelector: '[data-textarea]',
      emoji,
      onContentChange: newContent => {
        this.content = newContent;
        this.updatePostButton();
      },
    });
  }

  /**
   * Show NSFW switch after media upload
   */
  private showNSFWSwitch(): void {
    // Don't create switch if it already exists
    if (this.controls.nsfwSwitch) return;

    this.controls.nsfwSwitch = createNsfwSwitchIn(
      '#reply-note-options-container',
      this.isNSFW,
      checked => {
        this.isNSFW = checked;
        // Re-render preview if currently in preview tab
        if (this.currentTab === 'preview') {
          this.updatePreview();
        }
      }
    );
  }

  /**
   * Handle cancel button click
   */
  private handleCancel(): void {
    this.cleanup();
    this.modalService.hide();
  }

  /**
   * Handle post button click (publish reply or comment)
   */
  private async handlePost(): Promise<void> {
    if (!this.parentEvent) {
      this.systemLogger.error('ReplyModal', 'No parent event available');
      return;
    }

    // runComposerPublish validates content + auth-guards, hides the modal
    // behind the signer toast and dispatches success/failure. The reply
    // itself goes through createReply (wrapped as the createPost call).
    let replyEvent: import('@nostr-dev-kit/ndk').NostrEvent | null | undefined;

    await runComposerPublish({
      isHighlight: false,
      authLabel: 'reply to this note',
      content: this.content,
      selectedRelays: this.selectedRelays,
      pollData: null,
      isNSFW: this.isNSFW,
      customClientTag: '',
      scheduledAt: null,
      imageTagsPayload: [],
      gateScheduleOnPreference: false,
      hideEmojiPicker: () => this.controls.toolbar?.hideEmojiPicker(),
      createPost: async () => {
        this.systemLogger.info(
          'ReplyModal',
          `Calling PostService.createReply...`
        );
        replyEvent = await this.postsApi.get()?.createReply({
          content: this.content,
          parentEvent: this.parentEvent!,
          relays: Array.from(this.selectedRelays),
          contentWarning: this.isNSFW,
          asComment: this.isComment,
        });
        this.systemLogger.info(
          'ReplyModal',
          `Received reply event: ${replyEvent ? replyEvent.id?.slice(0, 8) : 'NULL'}`
        );
        return !!(replyEvent && replyEvent.id);
      },
      // Temporarily hide modal to allow extension popup to appear.
      beforePublish: () => {
        const modalContainer = document.querySelector('.modal') as HTMLElement;
        let originalDisplay = '';
        if (modalContainer) {
          originalDisplay = modalContainer.style.display;
          modalContainer.style.display = 'none';
        }
        return { modalContainer, originalDisplay };
      },
      onSuccess: () => {
        const event = replyEvent!;
        // Update parent note's reply count (cache invalidation + optimistic UI update)
        if (this.parentEvent?.id) {
          this.reactionsApi.get()?.clearCacheOnly(this.parentEvent.id);
        }

        // Emit event for optimistic UI update (SingleNoteView listens to this)
        this.systemLogger.info(
          'ReplyModal',
          `Emitting reply:created event for ${event.id?.slice(0, 8)}`
        );
        this.eventBus.emit('reply:created', event);

        this.cleanup();
        this.modalService.hide();
        this.systemLogger.success('PostService', 'Reply posted successfully');
      },
      onFailure: (_label, error, ctx) => {
        this.handlePostFailure(
          ctx?.modalContainer ?? null,
          ctx?.originalDisplay ?? '',
          error
        );
      },
    });
  }

  /**
   * Save the current reply text as a manual draft tied to its parent.
   */
  private handleSaveDraft(): void {
    saveComposerDraft({
      modalScope: '.reply-modal',
      draftType: 'reply',
      fallbackContent: this.content,
      ...(this.parentEvent?.id ? { parentEventId: this.parentEvent.id } : {}),
      contextLabel: _('Reply'),
    });
  }

  /**
   * A reply could not be signed/published: save it as a failed draft, restore
   * the composer, and offer a one-tap path into the Drafts tab.
   */
  private handlePostFailure(
    modalContainer: HTMLElement | null,
    originalDisplay: string,
    error?: unknown
  ): void {
    composerPostFailure({
      modalScope: '.reply-modal',
      draftType: 'reply',
      fallbackContent: this.content,
      modalContainer,
      originalDisplay,
      restoreLabel: _('Reply'),
      fallbackReason: _('Reply could not be published'),
      ...(this.parentEvent?.id ? { parentEventId: this.parentEvent.id } : {}),
      contextLabel: _('Reply'),
      onOpenDrafts: () => this.switchTab('drafts'),
      error,
    });
  }

  /**
   * Render quoted notes in preview
   */
  private async renderQuotedNotesInPreview(
    container: HTMLElement
  ): Promise<void> {
    await fillQuotedPreviewMarkers(this.content, container);
  }

  /**
   * Cleanup sub-components
   */
  private cleanup(): void {
    this.controls.destroy();

    if (this.commentSwitch) {
      this.commentSwitch.destroy();
      this.commentSwitch = null;
    }

    this.parentEvent = null;
  }

  /**
   * Lazy-load the custom emoji autocomplete and attach it to the textarea.
   * Only invoked when the Custom Emojis addon is enabled.
   */
  private async initCustomEmojiAutocomplete(): Promise<void> {
    const loaded = await loadComposerEmojiAutocomplete('ReplyModal');
    if (!loaded) return;
    this.controls.customEmojiService = loaded.service;
    this.controls.customEmojiAutocomplete = loaded.autocomplete;
  }

  private buildPreviewEmojiTags(content: string): string[][] {
    return scanComposerEmojiShortcodes(
      content,
      this.controls.customEmojiService
    );
  }
}
