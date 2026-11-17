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

import { _ } from '../../i18n';
import { LazyModuleApi } from '../../core/LazyModuleApi';
import { ModalService } from '../../services/ModalService';
import type { PostsModuleApi } from '../../modules/posts/contracts';
import { RelayConfig } from '../../services/RelayConfig';
import { loadEditorRelayConfig } from '../../helpers/editorRelayConfig';
import { switchComposerTab } from '../../helpers/switchComposerTab';
import { SystemLogger } from '../../services/SystemLogger';
import { AuthService } from '../../services/AuthService';
import { AuthGuard } from '../../services/AuthGuard';
import type { GifItem } from '../../services/GifSearchService';
import { setupPasteUpload } from '../../helpers/pasteUpload';
import {
  ModalEventHandlerManager,
  type TabMode,
} from '../modals/ModalEventHandlerManager';
import { NoteDraftService } from '../../services/NoteDraftService';
import { ToastService } from '../../services/ToastService';
import { EditorStateManager } from './EditorStateManager';
import { AppState } from '../../services/AppState';
import { isCustomEmojisEnabled } from '../../addons/custom-emojis/index';
import { isScheduledPostsEnabled } from '../../addons/scheduled-posts/index';
import {
  clearComposerQuoteCaches,
  runComposerPublish,
  composerHighlightQuoteHtml,
  composerEditorEditHtml,
  composerEditorPlaceholder,
  composerTabsHtml,
  createComposerHeaderControls,
  createComposerToolbar,
  composerPostButtonMeta,
  composerActionsHtml,
  composerSwitchTabPreviewHtml,
  mountComposerExpiryDropdown,
  composerScheduleHintHtml,
  updateComposerScheduleHint,
  updateComposerPostButtonLabel,
  pickComposerSchedule,
  composerInsertMedia,
  composerInsertEmoji,
  ComposerPoll,
  ComposerImageTags,
  ComposerControls,
  updateComposerDraftsBadge,
  setComposerActiveTab,
  saveComposerDraft,
  composerPostFailure,
  renderQuotedNotesInPreview as fillQuotedPreviewMarkers,
  renderComposerPreviewContent,
  updateComposerPreview,
  createNsfwSwitchIn,
  mountRelaySelectorInHeader,
  loadComposerEmojiAutocomplete,
  scanComposerEmojiShortcodes,
  createMentionAutocomplete,
  composerDraftsPanel,
  createComposerEventHandlers,
} from './composerShared';
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
  private postsApi = new LazyModuleApi<PostsModuleApi>('posts');
  private relayConfig: RelayConfig;
  private authService: AuthService;
  private systemLogger: SystemLogger;
  private appState: AppState;

  // Sub-components (shared teardown — see ComposerControls.destroy)
  private controls = new ComposerControls();
  /** Poll-creator toggle state (creator + live poll config). */
  private poll = new ComposerPoll();
  /** NIP-40: selected lifetime in seconds (undefined = never expires). */
  private expiresInSeconds: number | undefined;

  // State
  private currentTab: TabMode = 'edit';
  private content: string = '';
  private selectedRelays: Set<string> = new Set();
  private availableRelays: string[] = [];
  private isTestMode: boolean = false;
  private isNSFW: boolean = false;
  private scheduledAt: number | null = null;
  private highlightSource: HighlightSource | null = null;
  // Per-post custom client tag — overrides the global "via NoorNote" UI setting
  // for this one note. Empty = fall back to the UI setting (see AuthService.signEvent).
  private customClientTag: string = '';

  // NIP-68 image tagging state + overlay UI (scoped to the document-wide modal).
  private imageTags = new ComposerImageTags(
    () => document,
    'post-note-media-strip'
  );

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
  public show(
    options?:
      | string
      | { initialContent?: string; highlightSource?: HighlightSource }
  ): void {
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
      title: this.highlightSource ? _('New Highlight') : _('New Note'),
      content: modalContent,
      width: '650px',
      height: 'auto',
      showCloseButton: true,
      closeOnOverlay: false,
      closeOnEsc: true,
      onBeforeClose: () => this.confirmDiscardOrSave(),
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
      this.systemLogger.info(
        'PostNoteModal',
        'TEST mode: Using local relay only'
      );
      return;
    }

    // Relay-filtered timeline active → pre-select only that relay (on top of base).
    const selectedRelay = this.appState.getState('timeline').selectedRelay;
    if (selectedRelay) {
      this.selectedRelays = new Set([selectedRelay]);
      this.systemLogger.info(
        'PostNoteModal',
        `Relay filter active: Pre-selecting ${selectedRelay}`
      );
    } else {
      this.systemLogger.info(
        'PostNoteModal',
        `Normal mode: ${this.availableRelays.length} relays available`
      );
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
    return composerHighlightQuoteHtml(
      this.highlightSource?.selectedText ?? null
    );
  }

  /**
   * Render tabs header (Edit/Preview + Relay Selector)
   */
  private renderTabs(): string {
    // Create the shared header controls (relay selector + client tag).
    ({
      relaySelector: this.controls.relaySelector,
      clientTagControl: this.controls.clientTagControl,
    } = createComposerHeaderControls({
      availableRelays: this.availableRelays,
      selectedRelays: this.selectedRelays,
      isTestMode: this.isTestMode,
      customClientTag: this.customClientTag,
      onRelaysChange: selectedRelays => {
        this.selectedRelays = selectedRelays;
        this.updatePostButton();
      },
      onClientTagChange: value => {
        this.customClientTag = value;
      },
    }));

    return composerTabsHtml(this.currentTab);
  }

  /**
   * Refresh the Drafts tab count badge in place.
   */
  private updateDraftsTabBadge(): void {
    updateComposerDraftsBadge('.post-note-modal');
  }

  /**
   * Toggle the tab--active class across the composer tabs.
   */
  private setActiveTab(tab: TabMode): void {
    setComposerActiveTab('.post-note-modal', tab);
  }

  /**
   * Render editor/preview area
   */
  private renderEditor(): string {
    if (this.currentTab === 'edit') {
      return composerEditorEditHtml({
        content: this.content,
        placeholder: composerEditorPlaceholder(!!this.highlightSource),
        mediaStripId: 'post-note-media-strip',
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
      onPollToggle: () => this.handlePollToggle(),
      onScheduleClick: () => this.handleScheduleClick(),
      textareaSelector: '[data-textarea]',
      showSchedule: isScheduledPostsEnabled(),
    });

    // Highlight mode: comment is optional, only require relays.
    // Regular notes: require content (or poll) + relays.
    const { isValid, label } = composerPostButtonMeta({
      isHighlight: !!this.highlightSource,
      scheduledAt: this.scheduledAt,
      content: this.content,
      selectedRelays: this.selectedRelays,
      pollData: this.poll.data,
    });
    return composerActionsHtml({
      toolbarHtml: this.controls.toolbar.render(),
      optionsId: 'post-note-options-container',
      expiryId: 'post-note-expiry-container',
      hintId: 'post-note-schedule-hint',
      hintHtml: this.renderScheduleHintHtml(),
      showSaveDraft: !this.highlightSource,
      isValid,
      postLabel: label,
    });
  }

  /**
   * Render the "will be published on..." hint when a schedule is set.
   */
  private renderScheduleHintHtml(): string {
    return composerScheduleHintHtml(this.scheduledAt);
  }

  /**
   * NIP-40 "expires after" dropdown (composer). Mounted into its container;
   * renders nothing when expiry makes no sense (polls, quotes, highlights,
   * scheduled posts).
   */
  private mountExpiryDropdown(): void {
    this.controls.expiryDropdown = mountComposerExpiryDropdown({
      container: document.querySelector(
        '#post-note-expiry-container'
      ) as HTMLElement | null,
      blocked: !!(
        this.poll.data ||
        this.highlightSource ||
        this.scheduledAt !== null
      ),
      expiresInSeconds: this.expiresInSeconds,
      onSeconds: seconds => {
        this.expiresInSeconds = seconds;
      },
    });
  }

  /**
   * Update the schedule hint block (no full re-render).
   * Click-handler is attached via event delegation on the hint root,
   * so it survives any subsequent innerHTML replacements.
   */
  private updateScheduleHint(): void {
    updateComposerScheduleHint({
      scope: document,
      hintId: 'post-note-schedule-hint',
      scheduledAt: this.scheduledAt,
      onClear: () => {
        this.scheduledAt = null;
        this.updateScheduleHint();
        this.updatePostButtonLabel();
      },
    });
  }

  /**
   * Update the Post/Schedule button label based on scheduledAt state.
   */
  private updatePostButtonLabel(): void {
    updateComposerPostButtonLabel(document, this.scheduledAt);
  }

  /**
   * Open the date/time picker to schedule this post.
   */
  private async handleScheduleClick(): Promise<void> {
    await pickComposerSchedule({
      scheduledAt: this.scheduledAt,
      anchorEl: document.querySelector(
        '.post-note-toolbar [data-action="schedule"]'
      ) as HTMLElement | null,
      onPicked: timestampSeconds => {
        this.scheduledAt = timestampSeconds;
        this.updateScheduleHint();
        this.updatePostButtonLabel();
      },
    });
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    const modal = document.querySelector('.post-note-modal');
    if (!modal) return;

    // Mount relay selector into modal__header (outside overflow container)
    const modalHeader = modal.closest('.modal__body')
      ?.previousElementSibling as HTMLElement;
    const relaySelectorEl =
      this.controls.relaySelector && modalHeader
        ? mountRelaySelectorInHeader(modal, this.controls.relaySelector)
        : null;

    // Mount the client-tag control just before the relay selector
    // → header order: <h1>New Note</h1> | [tag icon+field] | Post to: | ×
    if (relaySelectorEl && this.controls.clientTagControl) {
      const clientTagDiv = document.createElement('div');
      clientTagDiv.innerHTML = this.controls.clientTagControl.render();
      const clientTagEl = clientTagDiv.firstElementChild as HTMLElement;
      modalHeader.insertBefore(clientTagEl, relaySelectorEl);
      this.controls.clientTagControl.setupEventListeners(clientTagEl);
    }

    // Setup toolbar
    const toolbarContainer = modal.querySelector('.post-note-toolbar');
    if (this.controls.toolbar && toolbarContainer) {
      this.controls.toolbar.setupEventListeners(
        toolbarContainer as HTMLElement
      );
    }

    // NIP-40 expiry dropdown
    this.mountExpiryDropdown();

    this.controls.mentionAutocomplete =
      createMentionAutocomplete('PostNoteModal');

    // Custom emoji shortcode autocomplete (addon-gated, lazy-loaded)
    if (isCustomEmojisEnabled()) {
      void this.initCustomEmojiAutocomplete();
    }

    this.controls.eventHandlerManager = createComposerEventHandlers({
      modalSelector: '.post-note-modal',
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

    // Paste-to-upload: a pasted image/video/audio is uploaded via the upload path.
    const textarea = modal.querySelector(
      '[data-textarea]'
    ) as HTMLElement | null;
    if (textarea)
      setupPasteUpload(
        textarea,
        files => void this.controls.toolbar?.handleFileUpload(files)
      );
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
      onEditRendered: () =>
        this.controls.eventHandlerManager?.refreshTextareaListener(),
      buildPreviewHtml: () => {
        const currentUser = this.authService.getCurrentUser();
        return composerSwitchTabPreviewHtml({
          content: this.content,
          isNSFW: this.isNSFW,
          currentUserPubkey: currentUser?.pubkey || '',
          scanEmojiTags: cleaned => this.buildPreviewEmojiTags(cleaned),
          pollData: this.poll.data,
        });
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

    if (rendered) {
      // Toggle poll-creator visibility based on tab
      const pollContainer = document.querySelector(
        '.post-note-modal #poll-creator-container'
      ) as HTMLElement;
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
      const btn = document.querySelector(
        '[data-action="post"]'
      ) as HTMLButtonElement | null;
      if (btn) btn.disabled = this.selectedRelays.size === 0;
      return;
    }
    EditorStateManager.updatePostButton(
      '[data-action="post"]',
      this.content,
      this.selectedRelays,
      this.poll.data
    );
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
    // NIP-68 image tagging — register URL in state + render thumbnail.
    // Skip non-image URLs (videos, audio) — NIP-68 is image-only.
    this.imageTags.registerUpload(url);
  }

  /**
   * GIF picked from the gifs.nostr.build picker — same insertion as uploads.
   * Deliberately NOT registered in the NIP-68 image-tag strip: the GIF's
   * imeta is emitted at publish time from the GIF meta cache instead
   * (two imeta tags for one URL would be invalid).
   */
  private handleGifSelected(gif: GifItem): void {
    composerInsertMedia({
      textareaSelector: '[data-textarea]',
      url: gif.url,
      onContentChange: newContent => {
        this.content = newContent;
        this.updatePostButton();
      },
      onShowNSFWSwitch: () => this.showNSFWSwitch(),
    });
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
      '#post-note-options-container',
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
   * Handle poll toggle
   */
  private handlePollToggle(): void {
    const pollContainer = document.querySelector('#poll-creator-container');
    this.poll.toggle(pollContainer, () => this.updatePostButton());
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
    const textarea = document.querySelector(
      '.post-note-modal [data-textarea]'
    ) as HTMLTextAreaElement | null;
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
      title: _('Save as draft?'),
      message: _('Keep this unsent note in your drafts?'),
      confirmText: _('Yes'),
      cancelText: _('No'),
    });
    if (save) {
      NoteDraftService.getInstance().add({
        type: 'note',
        content,
        failed: false,
      });
      ToastService.show(_('Draft saved'), 'success');
    }
  }

  /**
   * Handle post button click
   */
  private async handlePost(): Promise<void> {
    await runComposerPublish({
      isHighlight: !!this.highlightSource,
      onHighlight: () => this.handlePostHighlight(),
      content: this.content,
      selectedRelays: this.selectedRelays,
      pollData: this.poll.data,
      isNSFW: this.isNSFW,
      customClientTag: this.customClientTag,
      scheduledAt: this.scheduledAt,
      expiresInSeconds: this.expiresInSeconds,
      imageTagsPayload: this.imageTags.buildPayload(),
      // Classic modal: scheduling requires the stored addon preference.
      gateScheduleOnPreference: true,
      hideEmojiPicker: () => this.controls.toolbar?.hideEmojiPicker(),
      createPost: payload =>
        this.postsApi.get()?.createPost(payload) ?? Promise.resolve(false),
      // Hide the modal behind the signer-approval toast; the captured
      // container + display state is handed back for failure restore.
      beforePublish: () => {
        const modalContainer = document.querySelector('.modal') as HTMLElement;
        let originalDisplay = '';
        if (modalContainer) {
          originalDisplay = modalContainer.style.display;
          modalContainer.style.display = 'none';
        }
        return { modalContainer, originalDisplay };
      },
      onSuccess: quoted => {
        clearComposerQuoteCaches(quoted);
        this.cleanup();
        this.modalService.hide();
        this.systemLogger.success('PostService', 'Note posted successfully');
      },
      onFailure: (label, error, ctx) => {
        this.handlePostFailure(
          ctx?.modalContainer ?? null,
          ctx?.originalDisplay ?? '',
          label,
          error
        );
      },
    });
  }

  /**
   * Save the current composer content as a manual draft.
   */
  private handleSaveDraft(): void {
    saveComposerDraft({
      modalScope: '.post-note-modal',
      draftType: 'note',
      fallbackContent: this.content,
    });
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
    composerPostFailure({
      modalScope: '.post-note-modal',
      draftType: 'note',
      fallbackContent: this.content,
      modalContainer,
      originalDisplay,
      restoreLabel: label,
      fallbackReason: _('Note could not be published'),
      onOpenDrafts: () => this.switchTab('drafts'),
      error,
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

    this.controls.toolbar?.hideEmojiPicker();

    const modalContainer = document.querySelector('.modal') as HTMLElement;
    let originalDisplay = '';
    if (modalContainer) {
      originalDisplay = modalContainer.style.display;
      modalContainer.style.display = 'none';
    }

    try {
      const success = await this.postsApi.get()?.createHighlight({
        highlightedText: this.highlightSource.selectedText,
        comment: this.content,
        sourceEvent: this.highlightSource.event,
        relays: Array.from(this.selectedRelays),
      });

      if (success) {
        this.highlightSource = null;
        this.cleanup();
        this.modalService.hide();
      } else {
        ModalEventHandlerManager.restoreAfterError(
          modalContainer,
          originalDisplay,
          _('Post Highlight')
        );
      }
    } catch (error) {
      console.error('Highlight post error:', error);
      ModalEventHandlerManager.restoreAfterError(
        modalContainer,
        originalDisplay,
        _('Post Highlight')
      );
    }
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
    this.poll.destroy();

    // NIP-68 image-tagging state
    this.imageTags.destroy();

    this.scheduledAt = null;
    this.highlightSource = null;
  }

  /**
   * Lazy-load the custom emoji autocomplete and attach it to the textarea.
   * Only invoked when the Custom Emojis addon is enabled.
   */
  private async initCustomEmojiAutocomplete(): Promise<void> {
    const loaded = await loadComposerEmojiAutocomplete('PostNoteModal');
    if (!loaded) return;
    this.controls.customEmojiService = loaded.service;
    this.controls.customEmojiAutocomplete = loaded.autocomplete;
  }

  /**
   * Sync helper: scan the current content for `:shortcode:` and return matching
   * NIP-30 emoji tags. Used by the Preview tab so animated GIFs render inline.
   */
  private buildPreviewEmojiTags(content: string): string[][] {
    return scanComposerEmojiShortcodes(
      content,
      this.controls.customEmojiService
    );
  }
}
