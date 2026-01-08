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
import { PostService } from '../../services/PostService';
import { RelayConfig } from '../../services/RelayConfig';
import { SystemLogger } from '../system/SystemLogger';
import { AuthService } from '../../services/AuthService';
import { AuthGuard } from '../../services/AuthGuard';
import { RelaySelector } from './RelaySelector';
import { PostEditorToolbar } from './PostEditorToolbar';
import { renderPostPreview } from '../../helpers/renderPostPreview';
import { Switch } from '../ui/Switch';
import { PollCreator, type PollData } from '../poll/PollCreator';
import { extractQuotedReferences } from '../../helpers/extractQuotedReferences';
import { renderQuotePreview } from '../../helpers/renderQuotePreview';
import { decodeNip19 } from '../../services/NostrToolsAdapter';
import { StatsUpdateService } from '../../services/StatsUpdateService';
import { AppState } from '../../services/AppState';
import { ContentValidationManager } from './ContentValidationManager';
import { EditorStateManager } from './EditorStateManager';
import { MentionAutocomplete } from '../mentions/MentionAutocomplete';
import { ModalEventHandlerManager, type TabMode } from '../modals/ModalEventHandlerManager';

export class PostNoteModal {
  private static instance: PostNoteModal;
  private modalService: ModalService;
  private postService: PostService;
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

  private constructor() {
    this.modalService = ModalService.getInstance();
    this.postService = PostService.getInstance();
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
   * @param initialContent - Optional pre-filled content (for quoted reposts)
   */
  public show(initialContent?: string): void {
    this.currentTab = 'edit';
    this.content = initialContent || this.draftContent;
    this.loadRelayConfiguration();

    const modalContent = this.renderContent();

    this.modalService.show({
      title: 'New Note',
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
    const localRelaySettings = this.loadLocalRelaySettings();

    if (localRelaySettings.enabled) {
      this.isTestMode = true;
      this.availableRelays = [localRelaySettings.url];
      this.selectedRelays = new Set([localRelaySettings.url]);
      this.systemLogger.info('PostNoteModal', 'TEST mode: Using local relay only');
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
        this.systemLogger.info('PostNoteModal', `Relay filter active: Pre-selecting ${selectedRelay}`);
      } else {
        // No relay filter → select all write relays (default)
        const writeRelays = [...new Set(this.relayConfig.getWriteRelays())];
        this.selectedRelays = new Set(writeRelays);
        this.systemLogger.info('PostNoteModal', `Normal mode: ${this.availableRelays.length} relays available`);
      }
    }
  }

  /**
   * Load local relay settings from localStorage
   */
  private loadLocalRelaySettings(): { enabled: boolean; url: string; mode: string } {
    try {
      const stored = localStorage.getItem('noornote_local_relay');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (error) {
      console.warn('Failed to load local relay settings:', error);
    }

    return {
      enabled: false,
      mode: 'test',
      url: 'ws://localhost:7777'
    };
  }

  /**
   * Render modal content
   */
  private renderContent(): string {
    return `
      <div class="post-note-modal">
        ${this.renderTabs()}
        ${this.renderEditor()}
        <div id="poll-creator-container"></div>
        ${this.renderActions()}
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
        </div>
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
          placeholder="What's on your mind?"
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
      onPollToggle: () => this.handlePollToggle(),
      textareaSelector: '[data-textarea]'
    });

    // Check if post can be submitted (content OR poll, plus relays)
    const validation = ContentValidationManager.validate({
      content: this.content,
      selectedRelays: this.selectedRelays,
      pollData: this.pollData
    });
    const isPostDisabled = !validation.isValid;

    return `
      <div class="post-note-actions">
        ${this.toolbar.render()}
        <div class="post-note-buttons">
          <div class="post-note-options" id="post-note-options-container">
            <!-- NSFW switch will be inserted here after media upload -->
          </div>
          <div class="post-note-actions-right">
            <button class="btn btn--passive" data-action="cancel">Cancel</button>
            <button class="btn" data-action="post" ${isPostDisabled ? 'disabled' : ''}>Post</button>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    const modal = document.querySelector('.post-note-modal');
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

    // Setup mention autocomplete
    this.mentionAutocomplete = new MentionAutocomplete({
      textareaSelector: '[data-textarea]',
      onMentionInserted: (_npub, username) => {
        this.systemLogger.info('PostNoteModal', `Mention inserted: @${username}`);
      }
    });
    this.mentionAutocomplete.init();

    // NSFW switch is set up dynamically when media is uploaded

    // Setup event handler manager (tab switching, textarea, action buttons)
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
      onSubmit: () => this.handlePost()
    });
    this.eventHandlerManager.setupEventListeners();
  }

  /**
   * Switch between Edit/Preview tabs
   */
  private switchTab(tab: TabMode): void {
    this.currentTab = tab;

    // Re-render editor area
    const modal = document.querySelector('.post-note-modal');
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

        // Add poll preview if poll is configured
        const pollPreviewHtml = this.renderPollPreview();
        if (pollPreviewHtml) {
          previewContainer.innerHTML += pollPreviewHtml;
        }

        actions.parentNode?.insertBefore(previewContainer, actions);

        // Render quoted notes in preview
        this.renderQuotedNotesInPreview(previewContainer);
      }

      // Toggle poll-creator visibility based on tab
      const pollContainer = modal.querySelector('#poll-creator-container') as HTMLElement;
      if (pollContainer) {
        pollContainer.style.display = this.currentTab === 'edit' ? '' : 'none';
      }
    }
  }

  /**
   * Update post button state
   */
  private updatePostButton(): void {
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
    const textarea = document.querySelector('[data-textarea]') as HTMLTextAreaElement;
    if (textarea) {
      this.draftContent = textarea.value;
    } else {
      this.draftContent = this.content;
    }

    this.cleanup();
    this.modalService.hide();
  }

  /**
   * Handle post button click
   */
  private async handlePost(): Promise<void> {
    // Validate content before posting
    const validation = ContentValidationManager.validate({
      content: this.content,
      selectedRelays: this.selectedRelays,
      pollData: this.pollData
    });

    if (!validation.isValid) {
      return;
    }

    // Check authentication before posting (Write Event)
    if (!AuthGuard.requireAuth('create a post')) {
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
      // Extract quoted event data if present
      const quotedRefs = extractQuotedReferences(this.content);
      let quotedEvent: { eventId: string; authorPubkey: string; relayHint?: string } | undefined;

      // Also track quoted articles (naddr) separately
      let quotedArticle: { addressableId: string; authorPubkey: string; relayHint?: string } | undefined;

      if (quotedRefs.length > 0) {
        const ref = quotedRefs[0];
        const cleanRef = ref.id.replace(/^nostr:/, '');

        try {
          const decoded = decodeNip19(cleanRef);

          if (decoded.type === 'nevent') {
            // NORMAL NOTE: Use q-tag with event ID
            const neventData = decoded.data as { id: string; author?: string; relays?: string[] };
            quotedEvent = {
              eventId: neventData.id,
              authorPubkey: neventData.author || '',
              relayHint: neventData.relays?.[0]
            };
          } else if (decoded.type === 'naddr') {
            // LONG-FORM ARTICLE: Use a-tag with addressable identifier
            const naddrData = decoded.data as { kind: number; pubkey: string; identifier: string; relays?: string[] };
            const addressableId = `${naddrData.kind}:${naddrData.pubkey}:${naddrData.identifier}`;
            quotedArticle = {
              addressableId,
              authorPubkey: naddrData.pubkey,
              relayHint: naddrData.relays?.[0]
            };
          }
        } catch (error) {
          console.warn('Failed to decode quoted reference:', error);
        }
      }

      const success = await this.postService.createPost({
        content: this.content,
        relays: Array.from(this.selectedRelays),
        contentWarning: this.isNSFW,
        pollData: this.pollData || undefined,
        quotedEvent,
        quotedArticle // LONG-FORM ARTICLES: Use a-tag instead of q-tag
      });

      if (success) {
        // If this was a quoted repost, update stats for the quoted note
        if (quotedEvent && quotedEvent.eventId) {
          StatsUpdateService.getInstance().clearCacheOnly(quotedEvent.eventId);
        }
        // If this was a quoted article, update stats for the article
        if (quotedArticle && quotedArticle.addressableId) {
          StatsUpdateService.getInstance().clearCacheOnly(quotedArticle.addressableId);
        }

        this.draftContent = '';
        this.cleanup();
        this.modalService.hide();
        this.systemLogger.success('PostService', '✓ Note posted successfully');
      } else {
        if (modalContainer) {
          modalContainer.style.display = originalDisplay;
        }
        const postBtn = document.querySelector('[data-action="post"]') as HTMLButtonElement;
        if (postBtn) {
          postBtn.disabled = false;
          postBtn.textContent = 'Post';
        }
      }
    } catch (error) {
      console.error('Post error:', error);
      if (modalContainer) {
        modalContainer.style.display = originalDisplay;
      }
      const postBtn = document.querySelector('[data-action="post"]') as HTMLButtonElement;
      if (postBtn) {
        postBtn.disabled = false;
        postBtn.textContent = 'Post';
      }
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
   * Shows poll as it will appear after posting (non-interactive)
   */
  private renderPollPreview(): string {
    if (!this.pollData) return '';

    const validOptions = this.pollData.options.filter(o => o.label.trim());
    if (validOptions.length < 2) return '';

    // Meta-Info (Multiple Choice, End Date)
    let metaHtml = '';
    if (this.pollData.multipleChoice || this.pollData.endDate) {
      metaHtml = '<div class="nip88-poll__meta">';
      if (this.pollData.multipleChoice) {
        metaHtml += '<span class="nip88-poll__meta-item">Multiple choice allowed</span>';
      }
      if (this.pollData.endDate) {
        const endDate = new Date(this.pollData.endDate * 1000);
        metaHtml += `<span class="nip88-poll__meta-item">Ends ${endDate.toLocaleDateString()}</span>`;
      }
      metaHtml += '</div>';
    }

    // Options (as preview, not clickable)
    const optionsHtml = validOptions.map(option => `
      <div class="nip88-poll__option nip88-poll__option--preview">
        <span class="nip88-poll__option-label">${this.escapeHtml(option.label)}</span>
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
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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

    if (this.pollCreator) {
      this.pollCreator.destroy();
      this.pollCreator = null;
    }

    if (this.mentionAutocomplete) {
      this.mentionAutocomplete.destroy();
      this.mentionAutocomplete = null;
    }

    this.pollData = null;
  }
}
