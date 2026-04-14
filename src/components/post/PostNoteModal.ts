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
import { stripTrackingParams } from '../../helpers/stripTrackingParams';
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
import { isCustomEmojisEnabled } from '../../addons/custom-emojis/index';
import { isScheduledPostsEnabled } from '../../addons/scheduled-posts/index';
import { ModalEventHandlerManager, type TabMode } from '../modals/ModalEventHandlerManager';
import { escapeHtml } from '../../helpers/escapeHtml';

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
    const localRelaySettings = this.relayConfig.loadLocalRelaySettings();

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

    const validation = ContentValidationManager.validate({
      content: this.content,
      selectedRelays: this.selectedRelays,
      pollData: this.pollData
    });

    const postButtonLabel = this.scheduledAt !== null ? 'Schedule' : 'Post';
    return `
      <div class="l-row l-row--split">
        <div>
          ${this.toolbar.render()}
          <div class="post-note-options" id="post-note-options-container"></div>
          <div class="post-note-schedule-hint" id="post-note-schedule-hint">${this.renderScheduleHintHtml()}</div>
        </div>
        <div>
          <button class="btn btn--passive" data-action="cancel">Cancel</button>
          <button class="btn" data-action="post" ${validation.isValid ? '' : 'disabled'}>${postButtonLabel}</button>
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
   */
  private updateScheduleHint(): void {
    const hintEl = document.querySelector('#post-note-schedule-hint') as HTMLElement | null;
    if (!hintEl) return;
    hintEl.innerHTML = this.renderScheduleHintHtml();
    const clearBtn = hintEl.querySelector('[data-action="clear-schedule"]');
    clearBtn?.addEventListener('click', () => {
      this.scheduledAt = null;
      this.updateScheduleHint();
      this.updatePostButtonLabel();
    });
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
    const picked = await pickDateTime({
      title: 'Schedule Post',
      initial,
      min: new Date(Date.now() + 60 * 1000),
      max: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      confirmLabel: 'Schedule',
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
    const actions = modal.querySelector('.l-row--split');

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
          content: stripTrackingParams(this.content),
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
        success = await this.postService.createPost({
          content: this.content,
          relays: Array.from(this.selectedRelays),
          contentWarning: this.isNSFW,
          ...(this.pollData ? { pollData: this.pollData } : {}),
          ...(quotedEvent ? { quotedEvent } : {}),
          ...(quotedArticle ? { quotedArticle } : {})
        });
      }

      if (success) {
        if (quotedEvent?.eventId) {
          StatsUpdateService.getInstance().clearCacheOnly(quotedEvent.eventId);
        }
        if (quotedArticle?.addressableId) {
          StatsUpdateService.getInstance().clearCacheOnly(quotedArticle.addressableId);
        }

        this.draftContent = '';
        this.cleanup();
        this.modalService.hide();
        this.systemLogger.success('PostService', 'Note posted successfully');
      } else {
        ModalEventHandlerManager.restoreAfterError(modalContainer, originalDisplay, 'Post');
      }
    } catch (error) {
      console.error('Post error:', error);
      ModalEventHandlerManager.restoreAfterError(modalContainer, originalDisplay, 'Post');
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
