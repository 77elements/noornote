/**
 * NewNoteView Component
 * Full-page note composer at /timeline/new-note — the flat replacement
 * for the classic note modal in the v2 Focus UI. Same elements in the
 * same arrangement as the modal composer (Edit/Preview/Drafts tabs,
 * relay selector, client tag, textarea, media strip, poll, toolbar,
 * NSFW, expiry, schedule hint, save-draft/post actions), reused via the
 * shared composer helpers and sub-components.
 *
 * Pre-fills (quoted reposts, shared images, highlights, opened drafts)
 * arrive through the composerHandoff one-shot (see helpers/composerHandoff.ts).
 * On post success / cancel the view reports back via the onClose callback
 * (wired by the focus surface to "return to the timeline").
 */

import { View } from './View';
import { _ } from '../../i18n';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { PostsModuleApi } from '../../modules/posts/contracts';
import { RelayConfig } from '../../services/RelayConfig';
import { loadEditorRelayConfig } from '../../helpers/editorRelayConfig';
import { switchComposerTab } from '../../helpers/switchComposerTab';
import { SystemLogger } from '../../services/SystemLogger';
import { AuthService } from '../../services/AuthService';
import { AuthGuard } from '../../services/AuthGuard';
import { ModalService } from '../../services/ModalService';
import type { GifItem } from '../../services/GifSearchService';
import { setupPasteUpload } from '../../helpers/pasteUpload';
import { AddonLoader } from '../../addons/AddonLoader';
import { isScheduledPostsEnabled } from '../../addons/scheduled-posts/index';
import { isCustomEmojisEnabled } from '../../addons/custom-emojis/index';
import { type TabMode } from '../modals/ModalEventHandlerManager';
import { AppState } from '../../services/AppState';
import { EditorStateManager } from '../post/EditorStateManager';
import { NoteDraftService } from '../../services/NoteDraftService';
import { ToastService } from '../../services/ToastService';
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
  loadComposerEmojiAutocomplete,
  scanComposerEmojiShortcodes,
  createMentionAutocomplete,
  composerDraftsPanel,
  createComposerEventHandlers,
} from '../post/composerShared';
import { openDraftInComposer } from '../../helpers/draftRouter';
import { attachPreviewClickToEdit } from '../../helpers/previewClickToEdit';
import {
  takePendingComposerRequest,
  type HighlightSource,
} from '../../helpers/composerHandoff';

/** Scope root for all composer queries (unique per view instance). */
const SCOPE = '.new-note-view';

export interface NewNoteViewOptions {
  /** Called after a successful post or a confirmed cancel — returns to the timeline. */
  onClose?: () => void;
}

export class NewNoteView extends View {
  private container: HTMLElement;
  private readonly onClose: () => void;

  private readonly postsApi: PostsModuleApi | null;
  private readonly relayConfig: RelayConfig;
  private readonly authService: AuthService;
  private readonly systemLogger: SystemLogger;
  private readonly appState: AppState;

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
  private customClientTag: string = '';
  /** NIP-68 image tagging state + overlay UI (scoped to this view's container). */
  private imageTags = new ComposerImageTags(
    () => this.container,
    'new-note-media-strip'
  );
  private highlightSource: HighlightSource | null = null;
  /** Set when the view is closing unconditionally (post success / answered
   *  save-draft dialog) so confirmBack no longer vetoes the back. */
  private closing = false;

  /** Pending auto-grow frame (textarea grows with its content, see autoGrowTextarea). */
  private autoGrowFrame = 0;
  /** Bound resize listener so it can be removed again in destroy(). */
  private readonly onWindowResize = (): void => this.scheduleAutoGrow();

  constructor(options?: NewNoteViewOptions) {
    super();
    this.onClose = options?.onClose ?? (() => {});
    this.postsApi = ModuleLoader.getInstance().getApi<PostsModuleApi>('posts');
    this.relayConfig = RelayConfig.getInstance();
    this.authService = AuthService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.appState = AppState.getInstance();

    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--new-note';

    const request = takePendingComposerRequest();
    const initialContent = request?.initialContent;
    this.highlightSource = request?.highlightSource ?? null;

    this.currentTab = 'edit';
    this.content = initialContent ?? '';
    this.customClientTag = '';
    this.loadRelayConfiguration();

    this.render();
    // Attach event handlers on the next tick: the element is mounted into
    // the column / view container only after the constructor returns, and
    // the shared handler manager resolves its scope via document.querySelector
    // (same deferred setup the classic modal uses).
    setTimeout(() => {
      this.setupEventHandlers();
      this.scheduleAutoGrow();
      window.addEventListener('resize', this.onWindowResize);
    }, 0);
  }

  getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Back-veto for the focus surface: a dirty composer asks "Save as
   * draft?" first (mirrors the modal's guard on every dismiss path).
   */
  confirmBack(): boolean {
    if (this.closing || this.highlightSource) return true;
    const textarea = this.container.querySelector(
      '[data-textarea]'
    ) as HTMLTextAreaElement | null;
    const content = (textarea ? textarea.value : this.content).trim();
    if (!content) return true;
    queueMicrotask(() => void this.askSaveDraftThenClose(content));
    return false;
  }

  destroy(): void {
    window.removeEventListener('resize', this.onWindowResize);
    if (this.autoGrowFrame) cancelAnimationFrame(this.autoGrowFrame);
    this.cleanup();
    // Safety net for close paths that bypass onClose (e.g. account
    // switch): on-demand addons release here too (idempotent no-op when
    // already unloaded or permanently enabled).
    this.releaseOnDemandAddons();
    this.controls.eventHandlerManager?.destroy();
    this.controls.eventHandlerManager = null;
  }

  /**
   * Auto-grow the textarea with its content: it expands to fit the text so
   * no inner scrollbar appears — until the bottom of the scroll container
   * (the focus surface, fallback: the viewport) is reached. Past that limit
   * the height clamps and the textarea scrolls internally. Runs rAF-batched
   * so consecutive edits (typing, emoji insert, media insert) coalesce.
   */
  private scheduleAutoGrow(): void {
    if (this.autoGrowFrame) cancelAnimationFrame(this.autoGrowFrame);
    this.autoGrowFrame = requestAnimationFrame(() => {
      this.autoGrowFrame = 0;
      this.autoGrowTextarea();
    });
  }

  private autoGrowTextarea(): void {
    if (this.currentTab !== 'edit') return;
    const textarea = this.container.querySelector(
      '[data-textarea]'
    ) as HTMLTextAreaElement | null;
    if (!textarea) return;

    // Bottom boundary: nearest scrollable ancestor (the focus surface owns
    // scrolling in v2); viewport fallback covers detached/other contexts.
    // Whichever ends higher wins — the textarea never passes the screen.
    let boundaryBottom = window.innerHeight;
    let node: HTMLElement | null = textarea.parentElement;
    while (node && node !== document.body) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        boundaryBottom = Math.min(
          boundaryBottom,
          node.getBoundingClientRect().bottom
        );
        break;
      }
      node = node.parentElement;
    }

    // Measure natural height, then clamp to the space below the textarea
    // (small margin keeps the composer's action row reachable).
    const MIN_HEIGHT = 200;
    // Stop ~170px above the bottom edge: the two action-button rows below
    // the textarea (~94px) plus a $gap before and after them, plus the
    // ED-b settings tab (~31px + $gap) that overlays the action row when
    // open — otherwise the clamped composer produces double scrollbars.
    const BOTTOM_MARGIN = 170;
    textarea.style.height = 'auto';
    const natural = textarea.scrollHeight;
    const max = Math.max(
      MIN_HEIGHT,
      boundaryBottom - textarea.getBoundingClientRect().top - BOTTOM_MARGIN
    );
    const height = Math.min(natural, max);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = natural > max ? 'auto' : 'hidden';
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
        'NewNoteView',
        'TEST mode: Using local relay only'
      );
      return;
    }

    // Relay-filtered timeline active → pre-select only that relay (on top of base).
    const selectedRelay = this.appState.getState('timeline').selectedRelay;
    if (selectedRelay) {
      this.selectedRelays = new Set([selectedRelay]);
      this.systemLogger.info(
        'NewNoteView',
        `Relay filter active: Pre-selecting ${selectedRelay}`
      );
    }
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="new-note-view">
        <h1 class="new-note-view__title">${_('Write new note')}</h1>
        <div class="post-note-composer">
          ${this.renderTabs()}
          ${this.renderHighlightQuote()}
          ${this.renderEditor()}
          <div id="new-note-poll-container"></div>
          ${this.renderActions()}
        </div>
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
   * Render tabs header (Edit/Preview/Drafts + Relay Selector + Client Tag)
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

    return composerTabsHtml(
      this.currentTab,
      '<div class="new-note-view__controls" data-composer-controls></div>'
    );
  }

  /**
   * Render editor/preview area
   */
  private renderEditor(): string {
    if (this.currentTab === 'edit') {
      return composerEditorEditHtml({
        content: this.content,
        placeholder: composerEditorPlaceholder(!!this.highlightSource),
        mediaStripId: 'new-note-media-strip',
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
      textareaSelector: `${SCOPE} [data-textarea]`,
      // v2 on-demand addons: the schedule icon is always visible; the
      // Scheduled Posts code loads only when the icon is used
      // (handleScheduleClick) and unloads again when the work is done.
      showSchedule: true,
      // v2 on-demand: the custom emojis runtime is loaded with the
      // composer session — the picker uses its pack regardless of the
      // stored preference (preference keeps gating v1).
      onDemandCustomEmojis: true,
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
      optionsId: 'new-note-options-container',
      expiryId: 'new-note-expiry-container',
      hintId: 'new-note-schedule-hint',
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
      container: this.container.querySelector(
        '#new-note-expiry-container'
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
      scope: this.container,
      hintId: 'new-note-schedule-hint',
      scheduledAt: this.scheduledAt,
      onClear: () => {
        this.scheduledAt = null;
        this.updateScheduleHint();
        this.updatePostButtonLabel();
        // Pending schedule removed → the addon's work is done.
        this.releaseOnDemandAddons();
      },
    });
  }

  /**
   * Update the Post/Schedule button label based on scheduledAt state.
   */
  private updatePostButtonLabel(): void {
    updateComposerPostButtonLabel(this.container, this.scheduledAt);
  }

  /**
   * Open the date/time picker to schedule this post.
   */
  private async handleScheduleClick(): Promise<void> {
    await pickComposerSchedule({
      scheduledAt: this.scheduledAt,
      anchorEl: this.container.querySelector(
        '.post-note-toolbar [data-action="schedule"]'
      ) as HTMLElement | null,
      // On-demand addon activation: load the Scheduled Posts code now, at
      // the moment its functionality is first used (idempotent).
      ensureScheduledPosts: () =>
        AddonLoader.getInstance().ensureLoaded('scheduled-posts'),
      onPicked: timestampSeconds => {
        this.scheduledAt = timestampSeconds;
        this.updateScheduleHint();
        this.updatePostButtonLabel();
      },
      // Picker dismissed without a pick: unless a schedule is already
      // pending, the addon's functionality is no longer in use → release.
      onDismissed: () => {
        if (this.scheduledAt === null) this.releaseOnDemandAddons();
      },
    });
  }

  /**
   * Setup event handlers + mount header controls
   */
  private setupEventHandlers(): void {
    const composer = this.container.querySelector(
      '.post-note-composer'
    ) as HTMLElement | null;
    if (!composer) return;

    // Mount relay selector + client tag into the header controls row
    // (the flat view owns its header — the modal mounted these into
    // modal__header instead).
    const controls = composer.querySelector(
      '[data-composer-controls]'
    ) as HTMLElement | null;
    if (controls) {
      if (this.controls.clientTagControl) {
        const clientTagDiv = document.createElement('div');
        clientTagDiv.innerHTML = this.controls.clientTagControl.render();
        const clientTagEl = clientTagDiv.firstElementChild as HTMLElement;
        controls.appendChild(clientTagEl);
        this.controls.clientTagControl.setupEventListeners(clientTagEl);
      }
      if (this.controls.relaySelector) {
        const relayDiv = document.createElement('div');
        relayDiv.innerHTML = this.controls.relaySelector.render();
        const relayEl = relayDiv.firstElementChild as HTMLElement;
        controls.appendChild(relayEl);
        this.controls.relaySelector.setupEventListeners(relayEl);
      }
    }

    // Setup toolbar
    const toolbarContainer = composer.querySelector('.post-note-toolbar');
    if (this.controls.toolbar && toolbarContainer) {
      this.controls.toolbar.setupEventListeners(
        toolbarContainer as HTMLElement
      );
    }

    // NIP-40 expiry dropdown
    this.mountExpiryDropdown();

    this.controls.mentionAutocomplete =
      createMentionAutocomplete('NewNoteView');

    // Custom emoji shortcode autocomplete — v2 on-demand: the addon loads
    // with the composer session (autocomplete + picker pack), independent
    // of the stored preference; released again when the composer closes
    // (releaseOnDemandAddons).
    void AddonLoader.getInstance()
      .ensureLoaded('custom-emojis')
      .then(() => this.initCustomEmojiAutocomplete());

    this.controls.eventHandlerManager = createComposerEventHandlers({
      modalSelector: `${SCOPE} .post-note-composer`,
      currentTab: this.currentTab,
      onTabSwitch: tab => this.switchTab(tab),
      onTextInput: value => {
        this.content = value;
        this.updatePostButton();
        this.scheduleAutoGrow();
      },
      onCancel: () => this.handleCancel(),
      onSubmit: () => void this.handlePost(),
      onSaveDraft: () => this.handleSaveDraft(),
    });

    // Paste-to-upload: a pasted image/video/audio is uploaded via the upload path.
    const textarea = composer.querySelector(
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
    setComposerActiveTab(SCOPE, tab);

    const rendered = switchComposerTab({
      modalSelector: `${SCOPE} .post-note-composer`,
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
        onOpen: draft => this.handleOpenDraft(draft),
        onChanged: () => updateComposerDraftsBadge(SCOPE),
      }),
    });

    if (rendered) {
      // Toggle poll-creator visibility based on tab
      const pollContainer = this.container.querySelector(
        '#new-note-poll-container'
      ) as HTMLElement | null;
      if (pollContainer) {
        pollContainer.style.display = this.currentTab === 'edit' ? '' : 'none';
      }
      // Re-wire paste upload to the fresh textarea
      if (tab === 'edit') {
        const textarea = this.container.querySelector(
          '[data-textarea]'
        ) as HTMLElement | null;
        if (textarea)
          setupPasteUpload(
            textarea,
            files => void this.controls.toolbar?.handleFileUpload(files)
          );
        this.scheduleAutoGrow();
      }
    }
  }

  /**
   * Open a picked draft: note drafts load into THIS composer; reply
   * drafts hand off to the reply composer (overlay in both UIs).
   */
  private handleOpenDraft(
    draft: import('../../services/NoteDraftService').NoteDraft
  ): void {
    if (draft.type === 'reply' && draft.parentEventId) {
      openDraftInComposer(draft);
      return;
    }
    this.content = draft.content;
    this.switchTab('edit');
    const textarea = this.container.querySelector(
      '[data-textarea]'
    ) as HTMLTextAreaElement | null;
    if (textarea) textarea.value = this.content;
    this.updatePostButton();
    this.scheduleAutoGrow();
  }

  /**
   * Update post button state
   */
  private updatePostButton(): void {
    if (this.highlightSource) {
      const btn = this.container.querySelector(
        '[data-action="post"]'
      ) as HTMLButtonElement | null;
      if (btn) btn.disabled = this.selectedRelays.size === 0;
      return;
    }
    EditorStateManager.updatePostButton(
      `${SCOPE} [data-action="post"]`,
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
      textareaSelector: `${SCOPE} [data-textarea]`,
      url,
      onContentChange: newContent => {
        this.content = newContent;
        this.updatePostButton();
      },
      onShowNSFWSwitch: () => this.showNSFWSwitch(),
    });
    this.scheduleAutoGrow();
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
      textareaSelector: `${SCOPE} [data-textarea]`,
      url: gif.url,
      onContentChange: newContent => {
        this.content = newContent;
        this.updatePostButton();
      },
      onShowNSFWSwitch: () => this.showNSFWSwitch(),
    });
    this.scheduleAutoGrow();
  }

  /**
   * Handle emoji selected callback
   */
  private handleEmojiSelected(emoji: string): void {
    composerInsertEmoji({
      textareaSelector: `${SCOPE} [data-textarea]`,
      emoji,
      onContentChange: newContent => {
        this.content = newContent;
        this.updatePostButton();
      },
    });
    this.scheduleAutoGrow();
  }

  /**
   * Show NSFW switch after media upload
   */
  private showNSFWSwitch(): void {
    // Don't create switch if it already exists
    if (this.controls.nsfwSwitch) return;

    this.controls.nsfwSwitch = createNsfwSwitchIn(
      '#new-note-options-container',
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
    const pollContainer = this.container.querySelector(
      '#new-note-poll-container'
    );
    this.poll.toggle(pollContainer, () => this.updatePostButton());
    this.scheduleAutoGrow();
  }

  /**
   * v2 on-demand addon lifecycle: release addons whose functionality is no
   * longer needed. Scheduled Posts is the pilot — it was loaded on demand
   * when the schedule icon was used and unloads once the work is done
   * (schedule instruction accepted, or the composer closes without
   * scheduling). Permanently user-enabled addons (stored preference ON)
   * stay loaded — the login refresh keeps them alive anyway.
   */
  private releaseOnDemandAddons(): void {
    if (!isScheduledPostsEnabled()) {
      void AddonLoader.getInstance().deactivateOnDemand('scheduled-posts');
    }
    // Custom emojis releases only while the stored preference is OFF —
    // an opted-in user keeps the login load (unloading would churn a
    // fresh relay fetch on every composer session).
    if (!isCustomEmojisEnabled()) {
      void AddonLoader.getInstance().deactivateOnDemand('custom-emojis');
    }
  }

  /**
   * Handle cancel button click
   */
  private handleCancel(): void {
    // Route through the same unsaved-content guard as the surface back
    // action so every dismiss path behaves identically. When the guard
    // defers (dirty note), askSaveDraftThenClose() owns the cleanup + close.
    if (this.confirmBack()) {
      this.closing = true;
      this.cleanup();
      this.releaseOnDemandAddons();
      this.onClose();
    }
  }

  /**
   * Ask whether to keep the unsent note as a draft, then close.
   * Yes → persist via NoteDraftService; No (incl. ESC on the dialog) → discard.
   */
  private async askSaveDraftThenClose(content: string): Promise<void> {
    const save = await ModalService.getInstance().confirm({
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
    // The confirm dialog parked a same-URL history marker (OverlayStack);
    // its cleanup history.back() lands async and would otherwise restore
    // the composer URL AFTER our back-navigation rewrote it. Wait for
    // that popstate (timeout fallback) before returning to the list.
    const proceed = (): void => {
      window.removeEventListener('popstate', onPop);
      if (this.closing) return;
      this.closing = true;
      this.cleanup();
      this.releaseOnDemandAddons();
      this.onClose();
    };
    const onPop = (): void => proceed();
    window.addEventListener('popstate', onPop, { once: true });
    setTimeout(proceed, 300);
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
      // v2 on-demand addons: a picked schedule date IS the intent to
      // schedule — no dependency on the stored addon preference here.
      gateScheduleOnPreference: false,
      hideEmojiPicker: () => this.controls.toolbar?.hideEmojiPicker(),
      createPost: payload =>
        this.postsApi?.createPost(payload) ?? Promise.resolve(false),
      // Capture the post button for the failure-restore path.
      beforePublish: () => {
        const postBtn = this.container.querySelector(
          '[data-action="post"]'
        ) as HTMLButtonElement | null;
        return { postBtn };
      },
      onSuccess: quoted => {
        clearComposerQuoteCaches(quoted);
        this.closing = true;
        this.cleanup();
        this.releaseOnDemandAddons();
        this.onClose();
        this.systemLogger.success('NewNoteView', 'Note posted successfully');
      },
      onFailure: (label, error, ctx) => {
        this.handlePostFailure(ctx?.postBtn ?? null, label, error);
      },
    });
  }

  /**
   * Save the current composer content as a manual draft.
   */
  private handleSaveDraft(): void {
    saveComposerDraft({
      modalScope: SCOPE,
      draftType: 'note',
      fallbackContent: this.content,
    });
  }

  /**
   * A post could not be signed/published: save it as a failed draft, restore
   * the composer, and offer a one-tap path into the Drafts tab.
   */
  private handlePostFailure(
    _postBtn: HTMLButtonElement | null,
    label: string,
    error?: unknown
  ): void {
    composerPostFailure({
      modalScope: SCOPE,
      draftType: 'note',
      fallbackContent: this.content,
      modalContainer: null,
      originalDisplay: '',
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

    try {
      const success = await this.postsApi?.createHighlight({
        highlightedText: this.highlightSource.selectedText,
        comment: this.content,
        sourceEvent: this.highlightSource.event,
        relays: Array.from(this.selectedRelays),
      });

      if (success) {
        this.highlightSource = null;
        this.closing = true;
        this.cleanup();
        this.onClose();
      } else {
        ToastService.show(_('Post Highlight'), 'error');
      }
    } catch (error) {
      console.error('Highlight post error:', error);
      ToastService.show(_('Post Highlight'), 'error');
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
    const loaded = await loadComposerEmojiAutocomplete('NewNoteView');
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
