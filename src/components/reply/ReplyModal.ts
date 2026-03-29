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

import { ModalService } from '../../services/ModalService';
import { PostService } from '../../services/PostService';
import { RelayConfig } from '../../services/RelayConfig';
import { SystemLogger } from '../system/SystemLogger';
import { AuthService } from '../../services/AuthService';
import { AuthGuard } from '../../services/AuthGuard';
import { RelaySelector } from '../post/RelaySelector';
import { PostEditorToolbar } from '../post/PostEditorToolbar';
import { renderPostPreview } from '../../helpers/renderPostPreview';
import { Switch } from '../ui/Switch';
import { extractQuotedReferences } from '../../helpers/extractQuotedReferences';
import { renderQuotePreview } from '../../helpers/renderQuotePreview';
import { StatsUpdateService } from '../../services/StatsUpdateService';
import { AppState } from '../../services/AppState';
import { EventBus } from '../../services/EventBus';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { NoteUI } from '../ui/NoteUI';
import { ContentValidationManager } from '../post/ContentValidationManager';
import { EditorStateManager } from '../post/EditorStateManager';
import { MentionAutocomplete } from '../mentions/MentionAutocomplete';
import { ModalEventHandlerManager, type TabMode } from '../modals/ModalEventHandlerManager';

export class ReplyModal {
  private static instance: ReplyModal;
  private modalService: ModalService;
  private postService: PostService;
  private relayConfig: RelayConfig;
  private authService: AuthService;
  private systemLogger: SystemLogger;
  private appState: AppState;
  private statsUpdateService: StatsUpdateService;
  private eventBus: EventBus;

  // Sub-components
  private relaySelector: RelaySelector | null = null;
  private toolbar: PostEditorToolbar | null = null;
  private nsfwSwitch: Switch | null = null;
  private commentSwitch: Switch | null = null;
  private mentionAutocomplete: MentionAutocomplete | null = null;
  private eventHandlerManager: ModalEventHandlerManager | null = null;

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
    this.postService = PostService.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.authService = AuthService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.appState = AppState.getInstance();
    this.statsUpdateService = StatsUpdateService.getInstance();
    this.eventBus = EventBus.getInstance();
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
  public async show(parentNoteId: string, parentEvent?: NostrEvent): Promise<void> {
    // If parent event not provided, fetch from relays
    if (!parentEvent) {
      this.systemLogger.info('ReplyModal', `Fetching parent event from relays...`);
      const fetchedEvent = await this.fetchParentEvent(parentNoteId);

      if (!fetchedEvent) {
        this.systemLogger.error('ReplyModal', `Parent event not found: ${parentNoteId}`);
        return;
      }
      parentEvent = fetchedEvent;
    }

    this.parentEvent = parentEvent;
    this.currentTab = 'edit';
    this.content = '';
    // Default: Reply (kind:1) for kind:1 parents, Comment (kind:1111) for everything else
    this.isComment = !this.parentIsKind1;
    this.loadRelayConfiguration();

    const modalContent = this.renderContent();
    const title = this.isComment ? 'Comment' : 'Reply';

    this.modalService.show({
      title,
      content: modalContent,
      width: '700px',
      height: '580px',
      showCloseButton: true,
      closeOnOverlay: false,
      closeOnEsc: true
    });

    setTimeout(() => {
      this.setupEventHandlers();
    }, 0);
  }

  /**
   * Fetch parent event from relays (fallback when not in cache)
   */
  private async fetchParentEvent(noteId: string): Promise<NostrEvent | null> {
    const { fetchNostrEvents } = await import('../../helpers/fetchNostrEvents');
    const relays = this.relayConfig.getReadRelays();

    const result = await fetchNostrEvents({
      relays,
      ids: [noteId],
      limit: 1
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
    const localRelaySettings = this.relayConfig.loadLocalRelaySettings();

    if (localRelaySettings.enabled) {
      this.isTestMode = true;
      this.availableRelays = [localRelaySettings.url];
      this.selectedRelays = new Set([localRelaySettings.url]);
      this.systemLogger.info('ReplyModal', 'TEST mode: Using local relay only');
    } else {
      this.isTestMode = false;
      const allRelays = this.relayConfig.getAllRelays();
      const uniqueRelayUrls = [...new Set(allRelays.filter(r => r.isActive).map(r => r.url))];
      this.availableRelays = uniqueRelayUrls;

      // Check if timeline has a relay filter active
      const timelineState = this.appState.getState('timeline');
      const selectedRelay = timelineState.selectedRelay;

      if (selectedRelay) {
        // Relay-filtered timeline active → pre-select only this relay
        this.selectedRelays = new Set([selectedRelay]);
        this.systemLogger.info('ReplyModal', `Relay filter active: Pre-selecting ${selectedRelay}`);
      } else {
        // No relay filter → select all write relays (default)
        const writeRelays = [...new Set(this.relayConfig.getWriteRelays())];
        this.selectedRelays = new Set(writeRelays);
        this.systemLogger.info('ReplyModal', `Normal mode: ${this.availableRelays.length} relays available`);
      }
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

    // Render parent note using NoteUI (with header, without ISL)
    // Setting islFetchStats=false and isLoggedIn=false hides the ISL
    const noteElement = NoteUI.createNoteElement(this.parentEvent, {
      collapsible: false,
      islFetchStats: false,
      isLoggedIn: false,
      headerSize: 'medium',
      depth: 0
    });

    return `
      <div class="reply-modal-parent">
        <div class="reply-modal-parent-note">${noteElement.outerHTML}</div>
      </div>
    `;
  }

  /**
   * Render tabs header (Edit/Preview + Comment Switch + Relay Selector)
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

    // Comment/Reply switch — only for kind:1 parent events
    const commentSwitchHtml = this.parentIsKind1
      ? `<div class="reply-modal-type-switch" id="comment-switch-container"></div>`
      : '';

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
        </div>
        ${commentSwitchHtml}
        ${this.relaySelector.render()}
      </div>
    `;
  }

  /**
   * Render editor/preview area
   */
  private renderEditor(): string {
    if (this.currentTab === 'edit') {
      return `
        <textarea
          class="textarea"
          placeholder="Write your ${this.isComment ? 'comment' : 'reply'}..."
          data-textarea
        >${this.content}</textarea>
      `;
    } else {
      const currentUser = this.authService.getCurrentUser();
      const previewHTML = renderPostPreview({
        content: this.content,
        pubkey: currentUser?.pubkey || '',
        isNSFW: this.isNSFW
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
      textareaSelector: '[data-textarea]',
      showPoll: false // No polls in replies
    });

    // Check if reply can be submitted (content + relays)
    const validation = ContentValidationManager.validate({
      content: this.content,
      selectedRelays: this.selectedRelays
    });
    const isPostDisabled = !validation.isValid;
    const buttonLabel = this.isComment ? 'Comment' : 'Reply';

    return `
      <div class="post-note-actions">
        ${this.toolbar.render()}
        <div class="post-note-buttons">
          <div class="post-note-options" id="reply-note-options-container">
            <!-- NSFW switch will be inserted here after media upload -->
          </div>
          <div class="post-note-actions-right">
            <button class="btn btn--passive" data-action="cancel">Cancel</button>
            <button class="btn" data-action="post" ${isPostDisabled ? 'disabled' : ''}>${buttonLabel}</button>
          </div>
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

    // Setup relay selector
    const relaySelectorContainer = modal.querySelector('.post-note-relay-selector');
    if (this.relaySelector && relaySelectorContainer) {
      this.relaySelector.setupEventListeners(relaySelectorContainer as HTMLElement);
    }

    // Setup toolbar
    const toolbarContainer = modal.querySelector('.post-note-toolbar');
    if (this.toolbar && toolbarContainer) {
      this.toolbar.setupEventListeners(toolbarContainer as HTMLElement);
    }

    // Setup Comment/Reply switch (only for kind:1 parents)
    if (this.parentIsKind1) {
      this.setupCommentSwitch();
    }

    // Setup mention autocomplete
    this.mentionAutocomplete = new MentionAutocomplete({
      textareaSelector: '[data-textarea]',
      onMentionInserted: (_npub, username) => {
        this.systemLogger.info('ReplyModal', `Mention inserted: @${username}`);
      }
    });
    this.mentionAutocomplete.init();

    // Setup event handler manager (tab switching, textarea, action buttons)
    this.eventHandlerManager = new ModalEventHandlerManager({
      modalSelector: '.reply-modal',
      textareaSelector: '[data-textarea]',
      activeTabClass: 'tab--active',
      currentTab: this.currentTab,
      onTabSwitch: (tab) => this.switchTab(tab),
      onTextInput: (value) => {
        this.content = value;
        this.updatePostButton();
      },
      onCancel: () => this.handleCancel(),
      onSubmit: () => this.handlePost()
    });
    this.eventHandlerManager.setupEventListeners();
  }

  /**
   * Setup Comment/Reply switch with hint text
   */
  private setupCommentSwitch(): void {
    const container = document.querySelector('#comment-switch-container');
    if (!container) return;

    // Switch OFF = Reply (default for kind:1), Switch ON = Comment
    this.commentSwitch = new Switch({
      label: 'Comment',
      checked: this.isComment,
      onChange: (checked) => {
        this.isComment = checked;
        this.updateCommentSwitchHint();
        this.updateModalTitle();
        this.updatePostButton();
        this.updatePlaceholder();
      }
    });

    container.innerHTML = `
      <div class="reply-modal-type-switch__inner">
        ${this.commentSwitch.render()}
        <span class="reply-modal-type-hint" id="comment-type-hint">
          ${this.getCommentHint()}
        </span>
      </div>
    `;

    this.commentSwitch.setupEventListeners(container as HTMLElement);
  }

  /**
   * Get hint text for current mode
   */
  private getCommentHint(): string {
    return this.isComment
      ? 'Stays under this post (Kind:1111)'
      : 'Appears on your profile (Kind:1)';
  }

  /**
   * Update hint text when switch changes
   */
  private updateCommentSwitchHint(): void {
    const hint = document.querySelector('#comment-type-hint');
    if (hint) {
      hint.textContent = this.getCommentHint();
    }
  }

  /**
   * Update modal title based on Comment/Reply mode
   */
  private updateModalTitle(): void {
    const titleEl = document.querySelector('.modal__header h2');
    if (titleEl) {
      titleEl.textContent = this.isComment ? 'Comment' : 'Reply';
    }
  }

  /**
   * Update textarea placeholder
   */
  private updatePlaceholder(): void {
    const textarea = document.querySelector('[data-textarea]') as HTMLTextAreaElement;
    if (textarea) {
      textarea.placeholder = `Write your ${this.isComment ? 'comment' : 'reply'}...`;
    }
  }

  /**
   * Switch between Edit/Preview tabs
   */
  private switchTab(tab: TabMode): void {
    this.currentTab = tab;

    // Re-render editor area
    const modal = document.querySelector('.reply-modal');
    if (!modal) return;

    const header = modal.querySelector('.post-note-header');
    const actions = modal.querySelector('.post-note-actions');

    if (header && actions) {
      const oldEditor = modal.querySelector('.textarea') || modal.querySelector('.post-note-preview');
      if (oldEditor) {
        oldEditor.remove();
      }

      if (this.currentTab === 'edit') {
        const editorHtml = this.renderEditor();
        actions.insertAdjacentHTML('beforebegin', editorHtml);

        // Refresh textarea listener after DOM update
        if (this.eventHandlerManager) {
          this.eventHandlerManager.refreshTextareaListener();
        }
      } else {
        const previewContainer = document.createElement('div');
        previewContainer.className = 'post-note-preview';

        const currentUser = this.authService.getCurrentUser();
        previewContainer.innerHTML = renderPostPreview({
          content: this.content,
          pubkey: currentUser?.pubkey || '',
          isNSFW: this.isNSFW
        });

        actions.parentNode?.insertBefore(previewContainer, actions);

        // Render quoted notes in preview
        this.renderQuotedNotesInPreview(previewContainer);
      }
    }
  }

  /**
   * Update post button state
   */
  private updatePostButton(): void {
    const btn = document.querySelector('[data-action="post"]');
    if (btn) {
      btn.textContent = this.isComment ? 'Comment' : 'Reply';
    }
    EditorStateManager.updatePostButton(
      '[data-action="post"]',
      this.content,
      this.selectedRelays
    );
    // Restore label after EditorStateManager may have cleared it
    const btnAfter = document.querySelector('[data-action="post"]');
    if (btnAfter && btnAfter.textContent !== (this.isComment ? 'Comment' : 'Reply')) {
      btnAfter.textContent = this.isComment ? 'Comment' : 'Reply';
    }
  }

  /**
   * Update preview (used when NSFW switch changes)
   */
  private updatePreview(): void {
    const currentUser = this.authService.getCurrentUser();
    EditorStateManager.updatePreview('.post-note-preview', {
      content: this.content,
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

    const optionsContainer = document.querySelector('#reply-note-options-container');
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
    // Validate content before posting
    const validation = ContentValidationManager.validate({
      content: this.content,
      selectedRelays: this.selectedRelays
    });

    if (!validation.isValid) {
      return;
    }

    const label = this.isComment ? 'comment on' : 'reply to';

    // Check authentication before posting (Write Event)
    if (!AuthGuard.requireAuth(`${label} this note`)) {
      return;
    }

    if (!this.parentEvent) {
      this.systemLogger.error('ReplyModal', 'No parent event available');
      return;
    }

    // Hide emoji picker if open
    if (this.toolbar) {
      this.toolbar.hideEmojiPicker();
    }

    // Temporarily hide modal to allow extension popup to appear
    const modalContainer = document.querySelector('.modal') as HTMLElement;
    let originalDisplay = '';
    if (modalContainer) {
      originalDisplay = modalContainer.style.display;
      modalContainer.style.display = 'none';
    }

    try {
      const actionLabel = this.isComment ? 'Comment' : 'Reply';
      this.systemLogger.info('ReplyModal', `Calling PostService.createReply (${actionLabel})...`);

      const replyEvent = await this.postService.createReply({
        content: this.content,
        parentEvent: this.parentEvent,
        relays: Array.from(this.selectedRelays),
        contentWarning: this.isNSFW,
        asComment: this.isComment
      });

      this.systemLogger.info('ReplyModal', `Received ${actionLabel.toLowerCase()} event: ${replyEvent ? replyEvent.id?.slice(0, 8) : 'NULL'}`);

      if (replyEvent && replyEvent.id) {
        // Update parent note's reply count (cache invalidation + optimistic UI update)
        if (this.parentEvent?.id) {
          this.statsUpdateService.clearCacheOnly(this.parentEvent.id);
        }

        // Emit event for optimistic UI update (SingleNoteView listens to this)
        this.systemLogger.info('ReplyModal', `Emitting reply:created event for ${replyEvent.id.slice(0, 8)}`);
        this.eventBus.emit('reply:created', replyEvent);

        this.cleanup();
        this.modalService.hide();
        this.systemLogger.success('PostService', `${actionLabel} posted successfully`);
      } else {
        ModalEventHandlerManager.restoreAfterError(modalContainer, originalDisplay, actionLabel);
      }
    } catch (error) {
      console.error('Reply/Comment error:', error);
      const actionLabel = this.isComment ? 'Comment' : 'Reply';
      ModalEventHandlerManager.restoreAfterError(modalContainer, originalDisplay, actionLabel);
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
   * Cleanup sub-components
   */
  private cleanup(): void {
    if (this.relaySelector) {
      this.relaySelector.destroy();
      this.relaySelector = null;
    }

    if (this.toolbar) {
      this.toolbar.destroy();
      this.toolbar = null;
    }

    if (this.nsfwSwitch) {
      this.nsfwSwitch.destroy();
      this.nsfwSwitch = null;
    }

    if (this.commentSwitch) {
      this.commentSwitch.destroy();
      this.commentSwitch = null;
    }

    if (this.mentionAutocomplete) {
      this.mentionAutocomplete.destroy();
      this.mentionAutocomplete = null;
    }

    this.parentEvent = null;
  }
}
