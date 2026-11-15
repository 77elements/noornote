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
import type { ReactionsModuleApi } from '../../modules/reactions/contracts';
import { RelayConfig } from '../../services/RelayConfig';
import { loadEditorRelayConfig } from '../../helpers/editorRelayConfig';
import { switchComposerTab } from '../../helpers/switchComposerTab';
import { SystemLogger } from '../../services/SystemLogger';
import { AuthService } from '../../services/AuthService';
import { AuthGuard } from '../../services/AuthGuard';
import { ModalService } from '../../services/ModalService';
import { RelaySelector } from '../post/RelaySelector';
import { ClientTagControl } from '../post/ClientTagControl';
import { PostEditorToolbar } from '../post/PostEditorToolbar';
import type { GifItem } from '../../services/GifSearchService';
import { setupPasteUpload } from '../../helpers/pasteUpload';
import { Switch } from '../ui/Switch';
import { PollCreator, type PollData } from '../poll/PollCreator';
import { extractQuotedReferences } from '../../helpers/extractQuotedReferences';
import { decodeNip19 } from '../../services/NostrToolsAdapter';
import { AppState } from '../../services/AppState';
import { ContentValidationManager } from '../post/ContentValidationManager';
import { EditorStateManager } from '../post/EditorStateManager';
import { MentionAutocomplete } from '../mentions/MentionAutocomplete';
import { ProfileSearchComponent } from '../profile/ProfileSearchComponent';
import { isCustomEmojisEnabled } from '../../addons/custom-emojis/index';
import { isScheduledPostsEnabled } from '../../addons/scheduled-posts/index';
import {
  ModalEventHandlerManager,
  type TabMode,
} from '../modals/ModalEventHandlerManager';
import { escapeHtml } from '../../helpers/escapeHtml';
import { NoteDraftService } from '../../services/NoteDraftService';
import { ToastService } from '../../services/ToastService';
import {
  composerDraftsTabLabel,
  updateComposerDraftsBadge,
  setComposerActiveTab,
  saveComposerDraft,
  composerPostFailure,
  renderQuotedNotesInPreview as fillQuotedPreviewMarkers,
  renderComposerPreviewContent,
  buildComposerPreviewHtml,
  updateComposerPreview,
  createNsfwSwitchIn,
  loadComposerEmojiAutocomplete,
  scanComposerEmojiShortcodes,
  createMentionAutocomplete,
  composerDraftsPanel,
  createComposerEventHandlers,
} from '../post/composerShared';
import { openDraftInComposer } from '../../helpers/draftRouter';
import { EXPIRY_CHOICES } from '../../helpers/nip40';
import { NnDropdown } from '../ui/NnDropdown';
import { attachPreviewClickToEdit } from '../../helpers/previewClickToEdit';
import { isImageUrl } from '../../helpers/extractMedia';
import { UserProfileService } from '../../services/UserProfileService';
import {
  takePendingComposerRequest,
  type HighlightSource,
} from '../../helpers/composerHandoff';
import type { ImageTagEntry } from '../post/PostNoteModal';

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

  // Sub-components
  private relaySelector: RelaySelector | null = null;
  private clientTagControl: ClientTagControl | null = null;
  private toolbar: PostEditorToolbar | null = null;
  private nsfwSwitch: Switch | null = null;
  private pollCreator: PollCreator | null = null;
  /** NIP-40: selected lifetime in seconds (undefined = never expires). */
  private expiresInSeconds: number | undefined;
  private expiryDropdown: NnDropdown | null = null;
  private mentionAutocomplete: MentionAutocomplete | null = null;
  private customEmojiAutocomplete:
    | import('../../addons/custom-emojis/CustomEmojiAutocomplete').CustomEmojiAutocomplete
    | null = null;
  private customEmojiService:
    | import('../../addons/custom-emojis/EmojiService').EmojiService
    | null = null;

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
  private customClientTag: string = '';
  /** NIP-68 image tags: URL → tagged users. */
  private imageTags = new Map<string, ImageTagEntry[]>();
  private tagOverlays = new Map<string, ProfileSearchComponent>();
  private tagMentionAutocompletes = new Map<string, MentionAutocomplete>();
  private highlightSource: HighlightSource | null = null;
  /** Set when the view is closing unconditionally (post success / answered
   *  save-draft dialog) so confirmBack no longer vetoes the back. */
  private closing = false;

  /** Pending auto-grow frame (textarea grows with its content, see autoGrowTextarea). */
  private autoGrowFrame = 0;
  /** Bound resize listener so it can be removed again in destroy(). */
  private readonly onWindowResize = (): void => this.scheduleAutoGrow();

  /** Cap mirrored from the classic composer (also enforced in PostService). */
  private static readonly MAX_TAGS_PER_IMAGE = 50;

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
    this.eventHandlerManager?.destroy();
    this.eventHandlerManager = null;
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
    if (!this.highlightSource) return '';
    return `
      <div class="post-note-highlight-quote">
        <blockquote class="highlight__quote">${escapeHtml(this.highlightSource.selectedText)}</blockquote>
      </div>
    `;
  }

  /**
   * Render tabs header (Edit/Preview/Drafts + Relay Selector + Client Tag)
   */
  private renderTabs(): string {
    // Create relay selector component
    this.relaySelector = new RelaySelector({
      availableRelays: this.availableRelays,
      selectedRelays: this.selectedRelays,
      isTestMode: this.isTestMode,
      onChange: selectedRelays => {
        this.selectedRelays = selectedRelays;
        this.updatePostButton();
      },
    });

    // Per-post custom client tag control (mounted into the header controls row)
    this.clientTagControl = new ClientTagControl({
      initialValue: this.customClientTag,
      onChange: value => {
        this.customClientTag = value;
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
          >${composerDraftsTabLabel()}</button>
        </div>
        <div class="new-note-view__controls" data-composer-controls></div>
      </div>
    `;
  }

  /**
   * Render editor/preview area
   */
  private renderEditor(): string {
    if (this.currentTab === 'edit') {
      const placeholder = this.highlightSource
        ? _('Write your thoughts about this highlight (optional)…')
        : _("What's on your mind?");
      return `
        <textarea
          class="textarea"
          placeholder="${escapeHtml(placeholder)}"
          data-textarea
        >${this.content}</textarea>
        <div class="post-note-modal__media-strip" id="new-note-media-strip"></div>
      `;
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
    this.toolbar = new PostEditorToolbar({
      onMediaUploaded: url => this.handleMediaUploaded(url),
      onEmojiSelected: emoji => this.handleEmojiSelected(emoji),
      onGifSelected: gif => this.handleGifSelected(gif),
      onPollToggle: () => this.handlePollToggle(),
      onScheduleClick: () => this.handleScheduleClick(),
      textareaSelector: `${SCOPE} [data-textarea]`,
      showSchedule: isScheduledPostsEnabled(),
    });

    // Highlight mode: comment is optional, only require relays.
    // Regular notes: require content (or poll) + relays.
    const isValid = this.highlightSource
      ? this.selectedRelays.size > 0
      : ContentValidationManager.validate({
          content: this.content,
          selectedRelays: this.selectedRelays,
          pollData: this.pollData,
        }).isValid;

    const postButtonLabel = this.highlightSource
      ? _('Post Highlight')
      : this.scheduledAt !== null
        ? _('Schedule')
        : _('Post');
    return `
      <div class="l-row l-row--split">
        <div>
          ${this.toolbar.render()}
          <div class="post-note-options" id="new-note-options-container"></div>
          <div class="post-note-expiry" id="new-note-expiry-container"></div>
          <div class="post-note-schedule-hint" id="new-note-schedule-hint">${this.renderScheduleHintHtml()}</div>
        </div>
        <div>
          ${this.highlightSource ? '' : `<button class="btn btn--passive" data-action="save-draft">${_('Save draft')}</button>`}
          <button class="btn btn--passive" data-action="cancel">${_('Cancel')}</button>
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
      <span class="post-note-schedule-hint__text">${_('Will be published on')} ${escapeHtml(when)}</span>
      <button type="button" class="post-note-schedule-hint__clear" data-action="clear-schedule">${_('Clear')}</button>
    `;
  }

  /**
   * NIP-40 "expires after" dropdown (composer). Mounted into its container;
   * renders nothing when expiry makes no sense (polls, quotes, highlights,
   * scheduled posts).
   */
  private mountExpiryDropdown(): void {
    const container = this.container.querySelector(
      '#new-note-expiry-container'
    ) as HTMLElement | null;
    if (!container) return;

    if (this.pollData || this.highlightSource || this.scheduledAt !== null) {
      container.innerHTML = '';
      return;
    }

    const options = [
      { value: '', label: _('Never expires') },
      ...EXPIRY_CHOICES.map(c => ({
        value: String(c.seconds),
        label: _(c.labelKey),
      })),
      { value: 'custom', label: _('Custom…') },
    ];

    this.expiryDropdown = new NnDropdown({
      options,
      selectedValue: this.expiresInSeconds ? String(this.expiresInSeconds) : '',
      className: 'post-note-expiry__dropdown',
      width: '180px',
      onChange: value => {
        if (value === 'custom') {
          void this.pickCustomExpiry();
          return;
        }
        const seconds = Number(value);
        this.expiresInSeconds =
          Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
        this.expiryDropdown?.setCustomLabel('');
      },
    });

    container.innerHTML = '';
    container.appendChild(this.expiryDropdown.getElement());
  }

  /**
   * Custom expiry via the shared date/time picker (NIP-40 allows any unix
   * timestamp). Falls back to "never" when the picker is cancelled.
   */
  private async pickCustomExpiry(): Promise<void> {
    const { pickDateTime } = await import('../../helpers/datePickerModal');
    const picked = await pickDateTime({
      confirmLabel: _('Set expiry'),
      min: new Date(),
    });

    if (!picked) {
      // Cancelled — revert to "Never expires".
      this.expiresInSeconds = undefined;
      this.expiryDropdown?.setValue('');
      this.expiryDropdown?.setCustomLabel('');
      return;
    }

    const seconds = Math.max(
      60,
      Math.floor(picked.getTime() / 1000) - Math.floor(Date.now() / 1000)
    );
    this.expiresInSeconds = seconds;
    this.expiryDropdown?.setValue('custom');
    this.expiryDropdown?.setCustomLabel(picked.toLocaleString());
  }

  /**
   * Update the schedule hint block (no full re-render).
   * Click-handler is attached via event delegation on the hint root,
   * so it survives any subsequent innerHTML replacements.
   */
  private updateScheduleHint(): void {
    const hintEl = this.container.querySelector(
      '#new-note-schedule-hint'
    ) as HTMLElement | null;
    if (!hintEl) return;
    hintEl.innerHTML = this.renderScheduleHintHtml();
    if (!hintEl.dataset.delegated) {
      hintEl.dataset.delegated = 'true';
      hintEl.addEventListener('click', e => {
        const target = (e.target as HTMLElement).closest(
          '[data-action="clear-schedule"]'
        );
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
    const btn = this.container.querySelector(
      '[data-action="post"]'
    ) as HTMLButtonElement | null;
    if (!btn) return;
    btn.textContent = this.scheduledAt !== null ? _('Schedule') : _('Post');
  }

  /**
   * Open the date/time picker to schedule this post.
   */
  private async handleScheduleClick(): Promise<void> {
    const { pickDateTime } = await import('../../helpers/datePickerModal');
    const initial = this.scheduledAt
      ? new Date(this.scheduledAt * 1000)
      : new Date(Date.now() + 60 * 60 * 1000); // Default: +1h
    const anchorEl = this.container.querySelector(
      '.post-note-toolbar [data-action="schedule"]'
    ) as HTMLElement | null;
    const picked = await pickDateTime({
      title: _('Schedule Post'),
      initial,
      min: new Date(Date.now() + 60 * 1000),
      max: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      confirmLabel: _('Schedule'),
      ...(anchorEl ? { anchorEl } : {}),
    });
    if (!picked) return;
    this.scheduledAt = Math.floor(picked.getTime() / 1000);
    this.updateScheduleHint();
    this.updatePostButtonLabel();
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
      if (this.clientTagControl) {
        const clientTagDiv = document.createElement('div');
        clientTagDiv.innerHTML = this.clientTagControl.render();
        const clientTagEl = clientTagDiv.firstElementChild as HTMLElement;
        controls.appendChild(clientTagEl);
        this.clientTagControl.setupEventListeners(clientTagEl);
      }
      if (this.relaySelector) {
        const relayDiv = document.createElement('div');
        relayDiv.innerHTML = this.relaySelector.render();
        const relayEl = relayDiv.firstElementChild as HTMLElement;
        controls.appendChild(relayEl);
        this.relaySelector.setupEventListeners(relayEl);
      }
    }

    // Setup toolbar
    const toolbarContainer = composer.querySelector('.post-note-toolbar');
    if (this.toolbar && toolbarContainer) {
      this.toolbar.setupEventListeners(toolbarContainer as HTMLElement);
    }

    // NIP-40 expiry dropdown
    this.mountExpiryDropdown();

    this.mentionAutocomplete = createMentionAutocomplete('NewNoteView');

    // Custom emoji shortcode autocomplete (addon-gated, lazy-loaded)
    if (isCustomEmojisEnabled()) {
      void this.initCustomEmojiAutocomplete();
    }

    this.eventHandlerManager = createComposerEventHandlers({
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
        files => void this.toolbar?.handleFileUpload(files)
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
      onEditRendered: () => this.eventHandlerManager?.refreshTextareaListener(),
      buildPreviewHtml: () => {
        const currentUser = this.authService.getCurrentUser();
        let html = buildComposerPreviewHtml(
          this.content,
          this.isNSFW,
          currentUser?.pubkey || '',
          cleaned => this.buildPreviewEmojiTags(cleaned)
        );
        // Add poll preview if poll is configured
        const pollPreviewHtml = this.renderPollPreview();
        if (pollPreviewHtml) html += pollPreviewHtml;
        return html;
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
            files => void this.toolbar?.handleFileUpload(files)
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
      this.pollData
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
    EditorStateManager.handleMediaUploaded(url, `${SCOPE} [data-textarea]`, {
      onContentChange: newContent => {
        this.content = newContent;
        this.updatePostButton();
      },
      onShowNSFWSwitch: () => this.showNSFWSwitch(),
    });
    this.scheduleAutoGrow();
    // NIP-68 image tagging — register URL in state + render thumbnail.
    // Skip non-image URLs (videos, audio) — NIP-68 is image-only.
    if (isImageUrl(url)) {
      this.imageTags.set(url, []);
      this.appendToMediaStrip(url);
    }
  }

  /**
   * GIF picked from the gifs.nostr.build picker — same insertion as uploads.
   * Deliberately NOT registered in the NIP-68 image-tag strip: the GIF's
   * imeta is emitted at publish time from the GIF meta cache instead
   * (two imeta tags for one URL would be invalid).
   */
  private handleGifSelected(gif: GifItem): void {
    EditorStateManager.handleMediaUploaded(
      gif.url,
      `${SCOPE} [data-textarea]`,
      {
        onContentChange: newContent => {
          this.content = newContent;
          this.updatePostButton();
        },
        onShowNSFWSwitch: () => this.showNSFWSwitch(),
      }
    );
    this.scheduleAutoGrow();
  }

  /**
   * Append a thumbnail + tag-button to the media-strip.
   */
  private appendToMediaStrip(url: string): void {
    const strip = this.container.querySelector('#new-note-media-strip');
    if (!strip) return;

    const thumb = document.createElement('div');
    thumb.className = 'post-note-modal__media-thumb';
    thumb.dataset.imageUrl = url;
    thumb.innerHTML = `
      <img class="post-note-modal__media-thumb-img" src="${escapeHtml(url)}" alt="" loading="lazy">
      <button type="button" class="post-note-modal__tag-btn" data-tag-url="${escapeHtml(url)}" title="${_('Tag users in this image')}" aria-label="${_('Tag users')}">
        <svg width="14" height="14"><use href="#icon-tag"/></svg>
        <span class="post-note-modal__tag-badge is-hidden" data-tag-badge>0</span>
      </button>
    `;
    strip.appendChild(thumb);

    // Wire tag-button click
    const tagBtn = thumb.querySelector(
      '.post-note-modal__tag-btn'
    ) as HTMLElement;
    tagBtn.addEventListener('click', e => {
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
      triggerTitle: _('Tag users'),
      placeholder: _('Tag different users, separate by comma'),
      buttonText: _('Apply'),
      buttonLoadingText: _('Applying...'),
      buttonClass: 'btn-small btn-passive',
      statusEnabled: false,
      privacyHint: _('Tagged users will be publicly visible'),
      chipMode: true,
      initialChips: (this.imageTags.get(url) ?? []).map(e => ({ ...e })),
      onChipsChange: chips => {
        // Hard cap (UI guard before publish — also enforced in PostService).
        if (chips.length > NewNoteView.MAX_TAGS_PER_IMAGE) {
          ToastService.show(_('Only 50 tags permitted'), 'error');
          // Trim back to the cap so the user sees the limit enforced.
          const trimmed = chips.slice(0, NewNoteView.MAX_TAGS_PER_IMAGE);
          this.imageTags.set(url, trimmed);
        } else {
          this.imageTags.set(
            url,
            chips.map(c => ({ ...c }))
          );
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
        if (
          (this.imageTags.get(url) ?? []).length >
          NewNoteView.MAX_TAGS_PER_IMAGE
        ) {
          ToastService.show(_('Only 50 tags permitted'), 'error');
          return;
        }
        helpers.collapse();
      },
    });

    // Mount next to the thumbnail
    const allThumbs = Array.from(
      this.container.querySelectorAll('.post-note-modal__media-thumb')
    ) as HTMLElement[];
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
    const inputEl = component
      .getElement()
      .querySelector('.textinput-overlay__input') as HTMLInputElement | null;
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
    const allThumbs = Array.from(
      this.container.querySelectorAll('.post-note-modal__media-thumb')
    ) as HTMLElement[];
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

    await Promise.all(
      entries.map(async entry => {
        // Only enrich chips that still show the truncated-npub fallback.
        if (!entry.username.endsWith('…')) return;
        const real = await this.usernameFromPubkey(entry.pubkey);
        if (real) entry.username = real;
      })
    );

    // Update chip DOM if the overlay is still open.
    const component = this.tagOverlays.get(url);
    if (component) {
      const chipNames = component
        .getElement()
        .querySelectorAll('.textinput-overlay__chip-name');
      chipNames.forEach((el, i) => {
        if (entries[i]) el.textContent = entries[i].username;
      });
    }
  }

  /**
   * Update the count badge on a thumbnail after tag changes.
   */
  private updateTagBadge(url: string): void {
    const allBtns = Array.from(
      this.container.querySelectorAll('.post-note-modal__tag-btn')
    ) as HTMLElement[];
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
      const profile =
        await UserProfileService.getInstance().getUserProfile(hex);
      return profile?.name || profile?.display_name || null;
    } catch {
      return null;
    }
  }

  /**
   * Handle emoji selected callback
   */
  private handleEmojiSelected(emoji: string): void {
    EditorStateManager.handleEmojiSelected(emoji, `${SCOPE} [data-textarea]`, {
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
    if (this.nsfwSwitch) return;

    this.nsfwSwitch = createNsfwSwitchIn(
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
    if (!pollContainer) return;

    // Toggle poll creator
    if (this.pollCreator) {
      // Remove poll
      this.pollCreator.destroy();
      this.pollCreator = null;
      this.pollData = null;
      pollContainer.innerHTML = '';
      this.updatePostButton();
      this.scheduleAutoGrow();
    } else {
      // Add poll
      this.pollCreator = new PollCreator({
        onPollDataChange: data => {
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
        },
      });

      pollContainer.innerHTML = this.pollCreator.render();
      this.pollCreator.setupEventListeners(pollContainer as HTMLElement);
      this.scheduleAutoGrow();
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
    if (this.highlightSource) {
      await this.handlePostHighlight();
      return;
    }

    const validation = ContentValidationManager.validate({
      content: this.content,
      selectedRelays: this.selectedRelays,
      pollData: this.pollData,
    });

    if (!validation.isValid) return;
    if (!AuthGuard.requireAuth('create a post')) return;

    this.toolbar?.hideEmojiPicker();

    const postBtn = this.container.querySelector(
      '[data-action="post"]'
    ) as HTMLButtonElement | null;

    const postLabel = this.scheduledAt !== null ? _('Schedule') : _('Post');
    const loadingId = ToastService.loading(_('Waiting for signer approval…'));
    try {
      const quotedRefs = extractQuotedReferences(this.content);
      let quotedEvent:
        | { eventId: string; authorPubkey: string; relayHint?: string }
        | undefined;
      let quotedArticle:
        | { addressableId: string; authorPubkey: string; relayHint?: string }
        | undefined;

      const ref = quotedRefs[0];
      if (ref) {
        const cleanRef = ref.id.replace(/^nostr:/, '');

        try {
          const decoded = decodeNip19(cleanRef);

          if (decoded.type === 'nevent') {
            const neventData = decoded.data as {
              id: string;
              author?: string;
              relays?: string[];
            };
            const relayHint = neventData.relays?.[0];
            quotedEvent = {
              eventId: neventData.id,
              authorPubkey: neventData.author || '',
              ...(relayHint ? { relayHint } : {}),
            };
          } else if (decoded.type === 'naddr') {
            const naddrData = decoded.data as {
              kind: number;
              pubkey: string;
              identifier: string;
              relays?: string[];
            };
            const addressableId = `${naddrData.kind}:${naddrData.pubkey}:${naddrData.identifier}`;
            const relayHint = naddrData.relays?.[0];
            quotedArticle = {
              addressableId,
              authorPubkey: naddrData.pubkey,
              ...(relayHint ? { relayHint } : {}),
            };
          }
        } catch (error) {
          console.debug('Failed to decode quoted reference:', error);
        }
      }

      const clientTag = this.customClientTag.trim();

      let success: boolean;
      if (this.scheduledAt !== null && isScheduledPostsEnabled()) {
        const { scheduleNote } = await import(
          '../../addons/scheduled-posts/scheduleNote'
        );
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

        success =
          (await this.postsApi?.createPost({
            content: this.content,
            relays: Array.from(this.selectedRelays),
            contentWarning: this.isNSFW,
            ...(this.pollData ? { pollData: this.pollData } : {}),
            ...(quotedEvent ? { quotedEvent } : {}),
            ...(quotedArticle ? { quotedArticle } : {}),
            ...(clientTag ? { clientTag } : {}),
            ...(imageTagsPayload.length > 0
              ? { imageTags: imageTagsPayload }
              : {}),
            ...(this.expiresInSeconds
              ? { expiresInSeconds: this.expiresInSeconds }
              : {}),
          })) ?? false;
      }

      ToastService.dismiss(loadingId);

      if (success) {
        if (quotedEvent?.eventId) {
          ModuleLoader.getInstance()
            .getApi<ReactionsModuleApi>('reactions')
            ?.clearCacheOnly(quotedEvent.eventId);
        }
        if (quotedArticle?.addressableId) {
          ModuleLoader.getInstance()
            .getApi<ReactionsModuleApi>('reactions')
            ?.clearCacheOnly(quotedArticle.addressableId);
        }

        this.closing = true;
        this.cleanup();
        this.onClose();
        this.systemLogger.success('NewNoteView', 'Note posted successfully');
      } else {
        this.handlePostFailure(postBtn, postLabel);
      }
    } catch (error) {
      ToastService.dismiss(loadingId);
      this.handlePostFailure(postBtn, postLabel, error);
    }
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

    this.toolbar?.hideEmojiPicker();

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
   * Render poll preview for Preview tab
   */
  private renderPollPreview(): string {
    if (!this.pollData) return '';

    const validOptions = this.pollData.options.filter(o => o.label.trim());
    if (validOptions.length < 2) return '';

    const metaItems: string[] = [];
    if (this.pollData.multipleChoice) {
      metaItems.push(
        `<span class="nip88-poll__meta-item">${_('Multiple choice allowed')}</span>`
      );
    }
    if (this.pollData.endDate) {
      const endDate = new Date(this.pollData.endDate * 1000);
      metaItems.push(
        `<span class="nip88-poll__meta-item">Ends ${endDate.toLocaleDateString()}</span>`
      );
    }
    const metaHtml =
      metaItems.length > 0
        ? `<div class="nip88-poll__meta">${metaItems.join('')}</div>`
        : '';

    const optionsHtml = validOptions
      .map(
        option => `
      <div class="nip88-poll__option nip88-poll__option--preview">
        <span class="nip88-poll__option-label">${escapeHtml(option.label)}</span>
        <span class="nip88-poll__option-stats">
          <span class="nip88-poll__option-count">0 votes</span>
          <span class="nip88-poll__option-percentage">0%</span>
        </span>
        <span class="nip88-poll__option-bar" style="width: 0%"></span>
      </div>
    `
      )
      .join('');

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
    this.expiryDropdown?.destroy();
    this.expiryDropdown = null;
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
    const loaded = await loadComposerEmojiAutocomplete('NewNoteView');
    if (!loaded) return;
    this.customEmojiService = loaded.service;
    this.customEmojiAutocomplete = loaded.autocomplete;
  }

  /**
   * Sync helper: scan the current content for `:shortcode:` and return matching
   * NIP-30 emoji tags. Used by the Preview tab so animated GIFs render inline.
   */
  private buildPreviewEmojiTags(content: string): string[][] {
    return scanComposerEmojiShortcodes(content, this.customEmojiService);
  }
}
