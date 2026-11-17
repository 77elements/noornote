/**
 * Composer shared blocks — the byte-identical plumbing between
 * PostNoteModal and ReplyModal (drafts tab badge, tab switching, draft
 * saving, publish-failure recovery, quote-preview injection, preview
 * rendering, NSFW switch, relay-selector header mount, autocompletes,
 * event-handler wiring).
 *
 * Deliberately FUNCTIONS, not a base class: the two modals are divergent
 * singletons (visibility/geo/schedule/poll/tag-overlays vs parent-event
 * kind-switching) — parameterizing the identical blocks keeps them thin
 * without forcing a fragile generic over the differing parts.
 */

import { NoteDraftService } from '../../services/NoteDraftService';
import { ToastService } from '../../services/ToastService';
import {
  ModalEventHandlerManager,
  type TabMode,
} from '../modals/ModalEventHandlerManager';
import { SignerTimeoutError } from '../../services/SignerTimeoutError';
import { extractQuotedReferences } from '../../helpers/extractQuotedReferences';
import { renderQuotePreview } from '../../helpers/renderQuotePreview';
import { EditorStateManager } from './EditorStateManager';
import { AuthGuard } from '../../services/AuthGuard';
import { RelaySelector } from './RelaySelector';
import { ClientTagControl } from './ClientTagControl';
import { PostEditorToolbar } from './PostEditorToolbar';
import { renderDraftsList, setupDraftsList } from './DraftsListUI';
import { Switch } from '../ui/Switch';
import { PollCreator } from '../poll/PollCreator';
import { MentionAutocomplete } from '../mentions/MentionAutocomplete';
import { ProfileSearchComponent } from '../profile/ProfileSearchComponent';
import { renderPostPreview } from '../../helpers/renderPostPreview';
import { stripTrackingParams } from '../../helpers/stripTrackingParams';
import { SystemLogger } from '../../services/SystemLogger';
import { ModuleLoader } from '../../core/ModuleLoader';
import { ContentValidationManager } from './ContentValidationManager';
import { decodeNip19 } from '../../services/NostrToolsAdapter';
import { EXPIRY_CHOICES } from '../../helpers/nip40';
import { NnDropdown } from '../ui/NnDropdown';
import { isImageUrl } from '../../helpers/extractMedia';
import { UserProfileService } from '../../services/UserProfileService';
import { escapeHtml } from '../../helpers/escapeHtml';
import { isScheduledPostsEnabled } from '../../addons/scheduled-posts/index';
import { _ } from '../../i18n';

/** "Drafts" tab label with count badge (badge only when count > 0). */
export function composerDraftsTabLabel(): string {
  const count = NoteDraftService.getInstance().count();
  return `Drafts${count > 0 ? ` <span class="badge badge--accent">${count}</span>` : ''}`;
}

/** Refresh the Drafts tab count badge in place (scoped to one modal). */
export function updateComposerDraftsBadge(modalScope: string): void {
  const btn = document.querySelector(
    `${modalScope} [data-tab="drafts"]`
  ) as HTMLElement | null;
  if (btn) btn.innerHTML = composerDraftsTabLabel();
}

/** Toggle the tab--active class across the composer tabs (scoped). */
export function setComposerActiveTab(modalScope: string, tab: string): void {
  document.querySelectorAll(`${modalScope} [data-tab]`).forEach(el => {
    const tabEl = el as HTMLElement;
    tabEl.classList.toggle('tab--active', tabEl.dataset.tab === tab);
  });
}

/** Save the composer textarea content as a draft (per draft type). */
export function saveComposerDraft(opts: {
  modalScope: string;
  draftType: 'note' | 'reply';
  /** Fallback when the textarea is not in the DOM. */
  fallbackContent: string;
  parentEventId?: string;
  contextLabel?: string;
}): void {
  const textarea = document.querySelector(
    `${opts.modalScope} [data-textarea]`
  ) as HTMLTextAreaElement | null;
  const content = (textarea ? textarea.value : opts.fallbackContent).trim();
  if (!content) {
    ToastService.show(_('Nothing to save'), 'info');
    return;
  }
  NoteDraftService.getInstance().add({
    type: opts.draftType,
    content,
    failed: false,
    ...(opts.parentEventId ? { parentEventId: opts.parentEventId } : {}),
    ...(opts.contextLabel ? { contextLabel: opts.contextLabel } : {}),
  });
  ToastService.show(_('Draft saved'), 'success');
  updateComposerDraftsBadge(opts.modalScope);
}

/**
 * A post/reply could not be signed/published: save it as a failed draft,
 * restore the composer, and offer a one-tap path into the Drafts tab.
 */
export function composerPostFailure(opts: {
  modalScope: string;
  draftType: 'note' | 'reply';
  fallbackContent: string;
  modalContainer: HTMLElement | null;
  originalDisplay: string;
  restoreLabel: string;
  fallbackReason: string;
  parentEventId?: string;
  contextLabel?: string;
  onOpenDrafts: () => void;
  error?: unknown;
}): void {
  const reason =
    opts.error instanceof SignerTimeoutError
      ? 'Signer did not respond in time'
      : opts.error instanceof Error && opts.error.message
        ? opts.error.message
        : opts.fallbackReason;

  NoteDraftService.getInstance().add({
    type: opts.draftType,
    content: opts.fallbackContent,
    failed: true,
    failureReason: reason,
    ...(opts.parentEventId ? { parentEventId: opts.parentEventId } : {}),
    ...(opts.contextLabel ? { contextLabel: opts.contextLabel } : {}),
  });

  ModalEventHandlerManager.restoreAfterError(
    opts.modalContainer,
    opts.originalDisplay,
    opts.restoreLabel
  );
  updateComposerDraftsBadge(opts.modalScope);

  ToastService.showWithAction(`Failed to post: ${reason}`, 'error', {
    label: _('Open drafts'),
    onClick: opts.onOpenDrafts,
  });
}

/** Replace .quote-marker placeholders with fetched quote previews. */
export async function renderQuotedNotesInPreview(
  content: string,
  container: HTMLElement
): Promise<void> {
  const quotedRefs = extractQuotedReferences(content);
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
 * Build the inner preview HTML for a composer (no wrapper). Used by
 * `switchComposerTab`, which creates its own `.post-note-preview` container.
 */
export function buildComposerPreviewHtml(
  content: string,
  isNSFW: boolean,
  currentUserPubkey: string,
  scanEmojiTags: (cleanedContent: string) => string[][]
): string {
  const cleanedContent = stripTrackingParams(content);
  const extraTags = scanEmojiTags(cleanedContent);
  return renderPostPreview({
    content: cleanedContent,
    pubkey: currentUserPubkey,
    isNSFW,
    ...(extraTags.length > 0 ? { extraTags } : {}),
  });
}

/**
 * Render the non-edit tab content for the initial modal render: the preview
 * wrapped in its `.post-note-preview` container.
 */
export function renderComposerPreviewContent(
  content: string,
  isNSFW: boolean,
  currentUserPubkey: string,
  scanEmojiTags: (cleanedContent: string) => string[][]
): string {
  return `<div class="post-note-preview">${buildComposerPreviewHtml(
    content,
    isNSFW,
    currentUserPubkey,
    scanEmojiTags
  )}</div>`;
}

/** Refresh the preview pane (used when the NSFW switch or content changes). */
export function updateComposerPreview(
  content: string,
  isNSFW: boolean,
  currentUserPubkey: string,
  scanEmojiTags?: (cleanedContent: string) => string[][]
): void {
  const cleanedContent = stripTrackingParams(content);
  const extraTags = scanEmojiTags ? scanEmojiTags(cleanedContent) : [];
  EditorStateManager.updatePreview('.post-note-preview', {
    content: cleanedContent,
    pubkey: currentUserPubkey,
    isNSFW,
    ...(extraTags.length > 0 ? { extraTags } : {}),
  });
}

/** Create the NSFW switch inside the given options container, if present. */
export function createNsfwSwitchIn(
  containerSelector: string,
  checked: boolean,
  onToggle: (checked: boolean) => void
): Switch | null {
  const optionsContainer = document.querySelector(containerSelector);
  if (!optionsContainer) return null;

  const nsfwSwitch = new Switch({
    label: 'NSFW',
    checked,
    onChange: onToggle,
  });
  optionsContainer.innerHTML = nsfwSwitch.render();
  nsfwSwitch.setupEventListeners(optionsContainer as HTMLElement);
  return nsfwSwitch;
}

/**
 * Mount the relay selector into the modal header (outside the overflow
 * container), before the close button. Returns the mounted element so
 * callers can insert additional header controls (e.g. the client-tag field).
 */
export function mountRelaySelectorInHeader(
  modal: Element,
  relaySelector: RelaySelector
): HTMLElement | null {
  const modalHeader = modal.closest('.modal__body')
    ?.previousElementSibling as HTMLElement;
  if (!relaySelector || !modalHeader) return null;

  const relaySelectorDiv = document.createElement('div');
  relaySelectorDiv.innerHTML = relaySelector.render();
  const relaySelectorEl = relaySelectorDiv.firstElementChild as HTMLElement;
  modalHeader.insertBefore(
    relaySelectorEl,
    modalHeader.querySelector('.modal__close')
  );
  relaySelector.setupEventListeners(relaySelectorEl);
  return relaySelectorEl;
}

/**
 * Lazy-load the custom emoji autocomplete + service for a composer textarea.
 * Returns null when the Custom Emojis addon chunk fails to load.
 */
export async function loadComposerEmojiAutocomplete(
  sourceName: string
): Promise<{
  service: import('../../addons/custom-emojis/EmojiService').EmojiService;
  autocomplete: import('../../addons/custom-emojis/CustomEmojiAutocomplete').CustomEmojiAutocomplete;
} | null> {
  const logger = SystemLogger.getInstance();
  try {
    const [{ CustomEmojiAutocomplete }, { EmojiService }] = await Promise.all([
      import('../../addons/custom-emojis/CustomEmojiAutocomplete'),
      import('../../addons/custom-emojis/EmojiService'),
    ]);
    const service = EmojiService.getInstance();
    const autocomplete = new CustomEmojiAutocomplete({
      textareaSelector: '[data-textarea]',
      onEmojiInserted: shortcode => {
        logger.info(sourceName, `Custom emoji inserted: :${shortcode}:`);
      },
    });
    autocomplete.init();
    return { service, autocomplete };
  } catch (err) {
    logger.warn(
      sourceName,
      `Custom emoji autocomplete load failed: ${String(err)}`
    );
    return null;
  }
}

/**
 * Scan content for `:shortcode:` occurrences and return matching NIP-30
 * emoji tags. Used by the Preview tab so animated GIFs render inline.
 */
export function scanComposerEmojiShortcodes(
  content: string,
  service: import('../../addons/custom-emojis/EmojiService').EmojiService | null
): string[][] {
  if (!service) return [];
  const tags: string[][] = [];
  const seen = new Set<string>();
  const re = /:([a-zA-Z0-9_-]+):/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const code = m[1]!;
    if (seen.has(code)) continue;
    seen.add(code);
    const emoji = service.findEmoji(code);
    if (emoji) tags.push(['emoji', code, emoji.url]);
  }
  return tags;
}

/** Create the mention autocomplete attached to the composer textarea. */
export function createMentionAutocomplete(
  sourceName: string
): MentionAutocomplete {
  const autocomplete = new MentionAutocomplete({
    textareaSelector: '[data-textarea]',
    onMentionInserted: (_npub, username) => {
      SystemLogger.getInstance().info(
        sourceName,
        `Mention inserted: @${username}`
      );
    },
  });
  autocomplete.init();
  return autocomplete;
}

/**
 * Drafts-panel wiring for the tabs config: renders the drafts list and
 * handles open/delete interactions. `onOpen` receives the picked draft
 * (after the caller closes the modal), `onChanged` fires on list edits.
 */
export function composerDraftsPanel(handlers: {
  onOpen: (draft: import('../../services/NoteDraftService').NoteDraft) => void;
  onChanged: () => void;
}): {
  renderDraftsHtml: () => string;
  onDraftsRendered: (draftsContainer: HTMLElement) => void;
} {
  return {
    renderDraftsHtml: () => renderDraftsList(),
    onDraftsRendered: draftsContainer =>
      setupDraftsList(draftsContainer, {
        onOpen: draft => handlers.onOpen(draft),
        onChanged: handlers.onChanged,
      }),
  };
}

/** Build the shared modal event handlers (tabs, textarea, action buttons). */
export function createComposerEventHandlers(config: {
  modalSelector: string;
  currentTab: TabMode;
  onTabSwitch: (tab: TabMode) => void;
  onTextInput: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  onSaveDraft: () => void;
}): ModalEventHandlerManager {
  const manager = new ModalEventHandlerManager({
    modalSelector: config.modalSelector,
    textareaSelector: '[data-textarea]',
    activeTabClass: 'tab--active',
    currentTab: config.currentTab,
    onTabSwitch: config.onTabSwitch,
    onTextInput: config.onTextInput,
    onCancel: config.onCancel,
    onSubmit: config.onSubmit,
    onSaveDraft: config.onSaveDraft,
  });
  manager.setupEventListeners();
  return manager;
}

// ─────────────────────────────────────────────────────────────────────
// Shared render blocks (PostNoteModal ↔ NewNoteView)
// ─────────────────────────────────────────────────────────────────────

/** Read-only quote box for Highlight mode (NIP-84); empty when not a highlight. */
export function composerHighlightQuoteHtml(
  selectedText: string | null
): string {
  if (!selectedText) return '';
  return `
      <div class="post-note-highlight-quote">
        <blockquote class="highlight__quote">${escapeHtml(selectedText)}</blockquote>
      </div>
    `;
}

/** Composer textarea (Edit tab). `mediaStripId` omitted = no media strip. */
export function composerEditorEditHtml(opts: {
  content: string;
  placeholder: string;
  mediaStripId?: string | undefined;
}): string {
  return `
        <textarea
          class="textarea"
          placeholder="${escapeHtml(opts.placeholder)}"
          data-textarea
        >${opts.content}</textarea>${
          opts.mediaStripId
            ? `
        <div class="post-note-modal__media-strip" id="${opts.mediaStripId}"></div>`
            : ''
        }
      `;
}

/** Placeholder for the composer textarea (highlight mode = optional comment). */
export function composerEditorPlaceholder(isHighlight: boolean): string {
  return isHighlight
    ? _('Write your thoughts about this highlight (optional)…')
    : _("What's on your mind?");
}

/** Tabs header (Edit/Preview/Drafts). `extrasHtml` appends header controls. */
export function composerTabsHtml(currentTab: TabMode, extrasHtml = ''): string {
  return `
      <div class="post-note-header">
        <div class="tabs">
          <button
            class="tab ${currentTab === 'edit' ? 'tab--active' : ''}"
            data-tab="edit"
          >
            Edit
          </button>
          <button
            class="tab ${currentTab === 'preview' ? 'tab--active' : ''}"
            data-tab="preview"
          >
            Preview
          </button>
          <button
            class="tab ${currentTab === 'drafts' ? 'tab--active' : ''}"
            data-tab="drafts"
          >${composerDraftsTabLabel()}</button>
        </div>
        ${extrasHtml}
      </div>
    `;
}

/** Create the composer relay selector (shared config across composers). */
export function createComposerRelaySelector(opts: {
  availableRelays: string[];
  selectedRelays: Set<string>;
  isTestMode: boolean;
  onChange: (selectedRelays: Set<string>) => void;
}): RelaySelector {
  return new RelaySelector({
    availableRelays: opts.availableRelays,
    selectedRelays: opts.selectedRelays,
    isTestMode: opts.isTestMode,
    onChange: opts.onChange,
  });
}

/** Create the per-post custom client tag control (shared across composers). */
export function createComposerClientTagControl(opts: {
  initialValue: string;
  onChange: (value: string) => void;
}): ClientTagControl {
  return new ClientTagControl({
    initialValue: opts.initialValue,
    onChange: opts.onChange,
  });
}

/**
 * Validity + label for the post button: highlight mode only requires
 * relays; regular notes require content (or poll) + relays.
 */
export function composerPostButtonMeta(opts: {
  isHighlight: boolean;
  scheduledAt: number | null;
  content: string;
  selectedRelays: Set<string>;
  pollData: import('../poll/PollCreator').PollData | null;
}): { isValid: boolean; label: string } {
  const isValid = opts.isHighlight
    ? opts.selectedRelays.size > 0
    : ContentValidationManager.validate({
        content: opts.content,
        selectedRelays: opts.selectedRelays,
        pollData: opts.pollData,
      }).isValid;
  const label = opts.isHighlight
    ? _('Post Highlight')
    : opts.scheduledAt !== null
      ? _('Schedule')
      : _('Post');
  return { isValid, label };
}

/** Action row (toolbar + option containers + cancel/post buttons). */
export function composerActionsHtml(opts: {
  toolbarHtml: string;
  optionsId: string;
  expiryId: string;
  hintId: string;
  hintHtml: string;
  showSaveDraft: boolean;
  isValid: boolean;
  postLabel: string;
}): string {
  return `
      <div class="l-row l-row--split">
        <div>
          ${opts.toolbarHtml}
          <div class="post-note-options" id="${opts.optionsId}"></div>
          <div class="post-note-expiry" id="${opts.expiryId}"></div>
          <div class="post-note-schedule-hint" id="${opts.hintId}">${opts.hintHtml}</div>
        </div>
        <div>
          ${opts.showSaveDraft ? `<button class="btn btn--passive" data-action="save-draft">${_('Save draft')}</button>` : ''}
          <button class="btn btn--passive" data-action="cancel">${_('Cancel')}</button>
          <button class="btn" data-action="post" ${opts.isValid ? '' : 'disabled'}>${opts.postLabel}</button>
        </div>
      </div>
    `;
}

/**
 * Preview-pane HTML for tab switches: rendered note preview plus the poll
 * preview when a poll is configured.
 */
export function composerSwitchTabPreviewHtml(opts: {
  content: string;
  isNSFW: boolean;
  currentUserPubkey: string;
  scanEmojiTags: (cleanedContent: string) => string[][];
  pollData: import('../poll/PollCreator').PollData | null;
}): string {
  let html = buildComposerPreviewHtml(
    opts.content,
    opts.isNSFW,
    opts.currentUserPubkey,
    opts.scanEmojiTags
  );
  const pollPreviewHtml = composerPollPreviewHtml(opts.pollData);
  if (pollPreviewHtml) html += pollPreviewHtml;
  return html;
}

/** Render the NIP-88 poll preview for the Preview tab (empty when no poll). */
export function composerPollPreviewHtml(
  pollData: import('../poll/PollCreator').PollData | null
): string {
  if (!pollData) return '';

  const validOptions = pollData.options.filter(o => o.label.trim());
  if (validOptions.length < 2) return '';

  const metaItems: string[] = [];
  if (pollData.multipleChoice) {
    metaItems.push(
      `<span class="nip88-poll__meta-item">${_('Multiple choice allowed')}</span>`
    );
  }
  if (pollData.endDate) {
    const endDate = new Date(pollData.endDate * 1000);
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

// ─────────────────────────────────────────────────────────────────────
// NIP-40 expiry dropdown
// ─────────────────────────────────────────────────────────────────────

/**
 * NIP-40 "expires after" dropdown (composer). Mounted into its container;
 * renders nothing when expiry makes no sense (polls, quotes, highlights,
 * scheduled posts). Returns null when not mounted.
 */
export function mountComposerExpiryDropdown(opts: {
  container: HTMLElement | null;
  /** Poll/highlight/schedule present → expiry is hidden. */
  blocked: boolean;
  expiresInSeconds: number | undefined;
  /** Receives the picked seconds (undefined = never expires). */
  onSeconds: (seconds: number | undefined) => void;
}): NnDropdown | null {
  const container = opts.container;
  if (!container) return null;

  if (opts.blocked) {
    container.innerHTML = '';
    return null;
  }

  const options = [
    { value: '', label: _('Never expires') },
    ...EXPIRY_CHOICES.map(c => ({
      value: String(c.seconds),
      label: _(c.labelKey),
    })),
    { value: 'custom', label: _('Custom…') },
  ];

  const dropdown = new NnDropdown({
    options,
    selectedValue: opts.expiresInSeconds ? String(opts.expiresInSeconds) : '',
    className: 'post-note-expiry__dropdown',
    width: '180px',
    onChange: value => {
      if (value === 'custom') {
        void pickComposerCustomExpiry(dropdown, opts.onSeconds);
        return;
      }
      const seconds = Number(value);
      opts.onSeconds(
        Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
      );
      dropdown.setCustomLabel('');
    },
  });

  container.innerHTML = '';
  container.appendChild(dropdown.getElement());
  return dropdown;
}

/**
 * Custom expiry via the shared date/time picker (NIP-40 allows any unix
 * timestamp). Falls back to "never" when the picker is cancelled.
 */
export async function pickComposerCustomExpiry(
  dropdown: NnDropdown,
  onSeconds: (seconds: number | undefined) => void
): Promise<void> {
  const { pickDateTime } = await import('../../helpers/datePickerModal');
  const picked = await pickDateTime({
    confirmLabel: _('Set expiry'),
    min: new Date(),
  });

  if (!picked) {
    // Cancelled — revert to "Never expires".
    onSeconds(undefined);
    dropdown.setValue('');
    dropdown.setCustomLabel('');
    return;
  }

  const seconds = Math.max(
    60,
    Math.floor(picked.getTime() / 1000) - Math.floor(Date.now() / 1000)
  );
  onSeconds(seconds);
  dropdown.setValue('custom');
  dropdown.setCustomLabel(picked.toLocaleString());
}

// ─────────────────────────────────────────────────────────────────────
// Scheduling
// ─────────────────────────────────────────────────────────────────────

/** "Will be published on ..." hint block (empty when nothing scheduled). */
export function composerScheduleHintHtml(scheduledAt: number | null): string {
  if (scheduledAt === null) return '';
  const when = new Date(scheduledAt * 1000).toLocaleString();
  return `
      <span class="post-note-schedule-hint__icon">
        <svg width="14" height="14"><use href="#icon-calendar"/></svg>
      </span>
      <span class="post-note-schedule-hint__text">${_('Will be published on')} ${escapeHtml(when)}</span>
      <button type="button" class="post-note-schedule-hint__clear" data-action="clear-schedule">${_('Clear')}</button>
    `;
}

/**
 * Wire the clear-schedule click delegation on the hint root (idempotent —
 * survives subsequent innerHTML replacements of the hint content).
 */
export function wireComposerScheduleHint(
  hintEl: HTMLElement,
  onClear: () => void
): void {
  if (hintEl.dataset.delegated) return;
  hintEl.dataset.delegated = 'true';
  hintEl.addEventListener('click', e => {
    const target = (e.target as HTMLElement).closest(
      '[data-action="clear-schedule"]'
    );
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    onClear();
  });
}

/** Update the Post/Schedule button label based on scheduledAt state. */
export function updateComposerPostButtonLabel(
  scope: ParentNode,
  scheduledAt: number | null
): void {
  const btn = scope.querySelector(
    '[data-action="post"]'
  ) as HTMLButtonElement | null;
  if (!btn) return;
  btn.textContent = scheduledAt !== null ? _('Schedule') : _('Post');
}

/**
 * Open the date/time picker to schedule a post. `ensureScheduledPosts`
 * lets on-demand composers load the Scheduled Posts code at use time;
 * `onDismissed` fires when the picker is closed without a pick.
 */
export async function pickComposerSchedule(opts: {
  scheduledAt: number | null;
  anchorEl: HTMLElement | null;
  ensureScheduledPosts?: () => Promise<void>;
  onPicked: (timestampSeconds: number) => void;
  onDismissed?: () => void;
}): Promise<void> {
  if (opts.ensureScheduledPosts) await opts.ensureScheduledPosts();
  const { pickDateTime } = await import('../../helpers/datePickerModal');
  const initial = opts.scheduledAt
    ? new Date(opts.scheduledAt * 1000)
    : new Date(Date.now() + 60 * 60 * 1000); // Default: +1h
  const picked = await pickDateTime({
    title: _('Schedule Post'),
    initial,
    min: new Date(Date.now() + 60 * 1000),
    max: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    confirmLabel: _('Schedule'),
    ...(opts.anchorEl ? { anchorEl: opts.anchorEl } : {}),
  });
  if (!picked) {
    opts.onDismissed?.();
    return;
  }
  opts.onPicked(Math.floor(picked.getTime() / 1000));
}

// ─────────────────────────────────────────────────────────────────────
// Publish path
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// Publish path
// ─────────────────────────────────────────────────────────────────────

/**
 * Full composer publish flow shared by the note composers (highlight
 * dispatch, validation, auth guard, emoji-picker teardown, signer-approval
 * toast, publish, success/failure dispatch). `beforePublish` runs after
 * validation and returns per-attempt context handed back to the
 * success/failure callbacks (e.g. the hidden modal container for restore).
 */
export async function runComposerPublish<T>(opts: {
  isHighlight: boolean;
  /** Required when isHighlight — publishes the NIP-84 highlight. */
  onHighlight?: (() => Promise<void>) | undefined;
  /** AuthGuard label (default 'create a post'). */
  authLabel?: string | undefined;
  content: string;
  selectedRelays: Set<string>;
  pollData: import('../poll/PollCreator').PollData | null;
  isNSFW: boolean;
  customClientTag: string;
  scheduledAt: number | null;
  expiresInSeconds?: number | undefined;
  imageTagsPayload: { imageUrl: string; taggedPubkeys: string[] }[];
  /** Classic modal gates scheduling on the stored addon preference. */
  gateScheduleOnPreference: boolean;
  hideEmojiPicker: () => void;
  createPost: (
    payload: import('../../services/PostService').PostOptions
  ) => Promise<boolean>;
  beforePublish?: () => T;
  onSuccess: (quoted: ComposerQuotedRefs, ctx: T | undefined) => void;
  onFailure: (label: string, error: unknown, ctx: T | undefined) => void;
}): Promise<void> {
  if (opts.isHighlight) {
    await opts.onHighlight?.();
    return;
  }

  const validation = ContentValidationManager.validate({
    content: opts.content,
    selectedRelays: opts.selectedRelays,
    pollData: opts.pollData,
  });

  if (!validation.isValid) return;
  if (!AuthGuard.requireAuth(opts.authLabel ?? 'create a post')) return;

  opts.hideEmojiPicker();
  const ctx = opts.beforePublish?.();

  const postLabel = opts.scheduledAt !== null ? _('Schedule') : _('Post');
  const loadingId = ToastService.loading(_('Waiting for signer approval…'));
  try {
    const quoted = resolveComposerQuotedRefs(opts.content);
    const success = await publishComposerNote({
      content: opts.content,
      relays: Array.from(opts.selectedRelays),
      contentWarning: opts.isNSFW,
      pollData: opts.pollData,
      quoted,
      clientTag: opts.customClientTag.trim(),
      scheduledAt: opts.scheduledAt,
      gateScheduleOnPreference: opts.gateScheduleOnPreference,
      expiresInSeconds: opts.expiresInSeconds,
      imageTagsPayload: opts.imageTagsPayload,
      createPost: opts.createPost,
    });

    ToastService.dismiss(loadingId);

    if (success) {
      opts.onSuccess(quoted, ctx);
    } else {
      opts.onFailure(postLabel, undefined, ctx);
    }
  } catch (error) {
    ToastService.dismiss(loadingId);
    opts.onFailure(postLabel, error, ctx);
  }
}

/** Decoded quote references attached to a composer note. */
export interface ComposerQuotedRefs {
  quotedEvent?:
    | { eventId: string; authorPubkey: string; relayHint?: string }
    | undefined;
  quotedArticle?:
    | { addressableId: string; authorPubkey: string; relayHint?: string }
    | undefined;
}

/**
 * Extract + decode the first quoted reference (`nostr:nevent1…` / `naddr1…`)
 * in the composer content into the publish payload fields.
 */
export function resolveComposerQuotedRefs(content: string): ComposerQuotedRefs {
  const quotedRefs = extractQuotedReferences(content);
  const result: ComposerQuotedRefs = {};

  const ref = quotedRefs[0];
  if (!ref) return result;
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
      result.quotedEvent = {
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
      result.quotedArticle = {
        addressableId,
        authorPubkey: naddrData.pubkey,
        ...(relayHint ? { relayHint } : {}),
      };
    }
  } catch (error) {
    console.debug('Failed to decode quoted reference:', error);
  }
  return result;
}

/** Drop the preview caches for quoted notes/articles after a successful post. */
export function clearComposerQuoteCaches(quoted: ComposerQuotedRefs): void {
  if (quoted.quotedEvent?.eventId) {
    ModuleLoader.getInstance()
      .getApi<
        import('../../modules/reactions/contracts').ReactionsModuleApi
      >('reactions')
      ?.clearCacheOnly(quoted.quotedEvent.eventId);
  }
  if (quoted.quotedArticle?.addressableId) {
    ModuleLoader.getInstance()
      .getApi<
        import('../../modules/reactions/contracts').ReactionsModuleApi
      >('reactions')
      ?.clearCacheOnly(quoted.quotedArticle.addressableId);
  }
}

/**
 * Publish a composer note: schedules when a schedule is set, otherwise
 * posts immediately. `gateScheduleOnPreference` = the classic modal only
 * schedules when the Scheduled Posts addon is user-enabled; on-demand
 * composers (a picked date IS the intent) pass false.
 */
export async function publishComposerNote(opts: {
  content: string;
  relays: string[];
  contentWarning: boolean;
  pollData: import('../poll/PollCreator').PollData | null;
  quoted: ComposerQuotedRefs;
  clientTag: string;
  scheduledAt: number | null;
  gateScheduleOnPreference: boolean;
  expiresInSeconds?: number | undefined;
  imageTagsPayload?:
    | { imageUrl: string; taggedPubkeys: string[] }[]
    | undefined;
  createPost: (
    payload: import('../../services/PostService').PostOptions
  ) => Promise<boolean>;
}): Promise<boolean> {
  const { quotedEvent, quotedArticle } = opts.quoted;
  const shared = {
    content: opts.content,
    relays: opts.relays,
    contentWarning: opts.contentWarning,
    ...(opts.pollData ? { pollData: opts.pollData } : {}),
    ...(quotedEvent ? { quotedEvent } : {}),
    ...(quotedArticle ? { quotedArticle } : {}),
    ...(opts.clientTag ? { clientTag: opts.clientTag } : {}),
  };

  if (
    opts.scheduledAt !== null &&
    (!opts.gateScheduleOnPreference || isScheduledPostsEnabled())
  ) {
    const { scheduleNote } = await import(
      '../../addons/scheduled-posts/scheduleNote'
    );
    return scheduleNote({
      ...shared,
      scheduledAt: opts.scheduledAt,
    });
  }

  // Build optional imageTags payload from the per-URL state. Skip empty
  // entries and the whole field when nothing is tagged (keeps legacy
  // notes byte-identical to before NIP-68 support).
  const imageTagsPayload = opts.imageTagsPayload ?? [];
  return opts.createPost({
    ...shared,
    ...(imageTagsPayload.length > 0 ? { imageTags: imageTagsPayload } : {}),
    ...(opts.expiresInSeconds
      ? { expiresInSeconds: opts.expiresInSeconds }
      : {}),
  });
}

// ─────────────────────────────────────────────────────────────────────
// Poll creator
// ─────────────────────────────────────────────────────────────────────

/**
 * Poll-creator toggle state shared by the note composers. `data` is the
 * live poll config (null = none), `creator` the mounted component.
 */
export class ComposerPoll {
  creator: PollCreator | null = null;
  data: import('../poll/PollCreator').PollData | null = null;

  /** Toggle the poll creator inside its container. `onUpdate` revalidates the post button. */
  toggle(container: Element | null, onUpdate: () => void): void {
    if (!container) return;

    // Toggle poll creator
    if (this.creator) {
      // Remove poll
      this.creator.destroy();
      this.creator = null;
      this.data = null;
      container.innerHTML = '';
      onUpdate();
    } else {
      // Add poll
      this.creator = new PollCreator({
        onPollDataChange: data => {
          if (data === null) {
            // Remove poll requested
            this.creator?.destroy();
            this.creator = null;
            this.data = null;
            container.innerHTML = '';
          } else {
            this.data = data;
          }
          // Update post button state when poll data changes
          onUpdate();
        },
      });

      container.innerHTML = this.creator.render();
      this.creator.setupEventListeners(container as HTMLElement);
    }
  }

  /** Destroy the creator (keep poll data — used on publish failure restore). */
  destroyCreator(): void {
    this.creator?.destroy();
    this.creator = null;
  }

  destroy(): void {
    this.destroyCreator();
    this.data = null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// NIP-68 image tagging
// ─────────────────────────────────────────────────────────────────────

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

/** Hard cap of tags per image (UI guard before publish — also enforced in PostService). */
export const MAX_TAGS_PER_IMAGE = 50;

/**
 * NIP-68 image-tag state + overlay UI for a composer: per-URL tag maps,
 * the media strip thumbnails, the tag overlay components and their
 * mention autocompletes. `root` scopes DOM queries (modal = document,
 * flat view = its container).
 */
export class ComposerImageTags {
  private readonly imageTags = new Map<string, ImageTagEntry[]>();
  private readonly tagOverlays = new Map<
    string,
    InstanceType<typeof ProfileSearchComponent>
  >();
  private readonly tagMentionAutocompletes = new Map<
    string,
    MentionAutocomplete
  >();

  constructor(
    private readonly root: () => ParentNode | null,
    private readonly stripId: string
  ) {}

  /** Register an uploaded media URL for tagging (images only — NIP-68 is image-only). */
  registerUpload(url: string): void {
    if (!isImageUrl(url)) return;
    this.imageTags.set(url, []);
    this.appendToMediaStrip(url);
  }

  /** Publish payload from the per-URL state (empty array = nothing tagged). */
  buildPayload(): { imageUrl: string; taggedPubkeys: string[] }[] {
    return Array.from(this.imageTags.entries())
      .filter(([, tags]) => tags.length > 0)
      .map(([imageUrl, tags]) => ({
        imageUrl,
        taggedPubkeys: tags.map(t => t.pubkey),
      }));
  }

  /** Full teardown (composer cleanup). */
  destroy(): void {
    this.tagOverlays.forEach(c => c.destroy());
    this.tagOverlays.clear();
    this.tagMentionAutocompletes.forEach(a => a.destroy());
    this.tagMentionAutocompletes.clear();
    this.imageTags.clear();
  }

  /** Append a thumbnail + tag-button to the media-strip. */
  private appendToMediaStrip(url: string): void {
    const strip = this.root()?.querySelector(`#${this.stripId}`);
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
   * and pre-filled with the chips currently stored in the tag map.
   *
   * State survives close/reopen because chips are live-synced to the map
   * via `onChipsChange`. The component itself is destroyed on close so
   * outside-click / ESC / Apply all clean up identically.
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
        if (chips.length > MAX_TAGS_PER_IMAGE) {
          ToastService.show(_('Only 50 tags permitted'), 'error');
          // Trim back to the cap so the user sees the limit enforced.
          const trimmed = chips.slice(0, MAX_TAGS_PER_IMAGE);
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
        if ((this.imageTags.get(url) ?? []).length > MAX_TAGS_PER_IMAGE) {
          ToastService.show(_('Only 50 tags permitted'), 'error');
          return;
        }
        helpers.collapse();
      },
    });

    // Mount next to the thumbnail
    const allThumbs = Array.from(
      this.root()?.querySelectorAll('.post-note-modal__media-thumb') ?? []
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
      this.root()?.querySelectorAll('.post-note-modal__media-thumb') ?? []
    ) as HTMLElement[];
    const thumb = allThumbs.find(t => t.dataset.imageUrl === url);
    thumb?.querySelector('.post-note-modal__tag-overlay-host')?.remove();
  }

  /**
   * Background-pass: resolve real usernames for chips whose `username` is
   * still the truncated-npub fallback. Mutates the tag map in place
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

  /** Update the count badge on a thumbnail after tag changes. */
  private updateTagBadge(url: string): void {
    const allBtns = Array.from(
      this.root()?.querySelectorAll('.post-note-modal__tag-btn') ?? []
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

  /** Async username lookup via UserProfileService. */
  private async usernameFromPubkey(hex: string): Promise<string | null> {
    try {
      const profile =
        await UserProfileService.getInstance().getUserProfile(hex);
      return profile?.name || profile?.display_name || null;
    } catch {
      return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Sub-component teardown
// ─────────────────────────────────────────────────────────────────────

/** Create the composer toolbar with the shared handler plumbing. */
export function createComposerToolbar(opts: {
  onMediaUploaded: (url: string) => void;
  onEmojiSelected: (emoji: string) => void;
  onGifSelected: (
    gif: import('../../services/GifSearchService').GifItem
  ) => void;
  onPollToggle?: () => void;
  onScheduleClick?: () => void;
  textareaSelector: string;
  showPoll?: boolean;
  showSchedule?: boolean;
  onDemandCustomEmojis?: boolean;
}): PostEditorToolbar {
  return new PostEditorToolbar({
    onMediaUploaded: opts.onMediaUploaded,
    onEmojiSelected: opts.onEmojiSelected,
    onGifSelected: opts.onGifSelected,
    ...(opts.onPollToggle ? { onPollToggle: opts.onPollToggle } : {}),
    ...(opts.onScheduleClick ? { onScheduleClick: opts.onScheduleClick } : {}),
    textareaSelector: opts.textareaSelector,
    ...(opts.showPoll !== undefined ? { showPoll: opts.showPoll } : {}),
    ...(opts.showSchedule !== undefined
      ? { showSchedule: opts.showSchedule }
      : {}),
    ...(opts.onDemandCustomEmojis
      ? { onDemandCustomEmojis: opts.onDemandCustomEmojis }
      : {}),
  });
}

/**
 * Create the two header controls (relay selector + per-post client tag)
 * with the shared wiring: relay changes revalidate the post button.
 */
export function createComposerHeaderControls(opts: {
  availableRelays: string[];
  selectedRelays: Set<string>;
  isTestMode: boolean;
  customClientTag: string;
  onRelaysChange: (selectedRelays: Set<string>) => void;
  onClientTagChange: (value: string) => void;
}): { relaySelector: RelaySelector; clientTagControl: ClientTagControl } {
  return {
    relaySelector: createComposerRelaySelector({
      availableRelays: opts.availableRelays,
      selectedRelays: opts.selectedRelays,
      isTestMode: opts.isTestMode,
      onChange: opts.onRelaysChange,
    }),
    clientTagControl: createComposerClientTagControl({
      initialValue: opts.customClientTag,
      onChange: opts.onClientTagChange,
    }),
  };
}

/**
 * Refresh the schedule hint block (no full re-render) and wire the
 * clear-schedule delegation (idempotent, survives innerHTML swaps).
 */
export function updateComposerScheduleHint(opts: {
  scope: ParentNode;
  hintId: string;
  scheduledAt: number | null;
  onClear: () => void;
}): void {
  const hintEl = opts.scope.querySelector(
    `#${opts.hintId}`
  ) as HTMLElement | null;
  if (!hintEl) return;
  hintEl.innerHTML = composerScheduleHintHtml(opts.scheduledAt);
  wireComposerScheduleHint(hintEl, opts.onClear);
}

/** Insert uploaded media into the composer textarea (via EditorStateManager). */
export function composerInsertMedia(opts: {
  textareaSelector: string;
  url: string;
  onContentChange: (content: string) => void;
  onShowNSFWSwitch?: () => void;
}): void {
  EditorStateManager.handleMediaUploaded(opts.url, opts.textareaSelector, {
    onContentChange: opts.onContentChange,
    ...(opts.onShowNSFWSwitch
      ? { onShowNSFWSwitch: opts.onShowNSFWSwitch }
      : {}),
  });
}

/** Insert a picked emoji into the composer textarea (via EditorStateManager). */
export function composerInsertEmoji(opts: {
  textareaSelector: string;
  emoji: string;
  onContentChange: (content: string) => void;
}): void {
  EditorStateManager.handleEmojiSelected(opts.emoji, opts.textareaSelector, {
    onContentChange: opts.onContentChange,
  });
}

/** Destroy every mounted composer sub-component (null fields stay null). */
export function destroyComposerControls(controls: {
  relaySelector?: { destroy(): void } | null;
  clientTagControl?: { destroy(): void } | null;
  toolbar?: { destroy(): void } | null;
  nsfwSwitch?: { destroy(): void } | null;
  expiryDropdown?: { destroy(): void } | null;
  pollCreator?: { destroy(): void } | null;
  mentionAutocomplete?: { destroy(): void } | null;
  customEmojiAutocomplete?: { destroy(): void } | null;
}): void {
  controls.relaySelector?.destroy();
  controls.clientTagControl?.destroy();
  controls.toolbar?.destroy();
  controls.nsfwSwitch?.destroy();
  controls.expiryDropdown?.destroy();
  controls.pollCreator?.destroy();
  controls.mentionAutocomplete?.destroy();
  controls.customEmojiAutocomplete?.destroy();
}

/**
 * Mounted sub-components of a note composer, shared by the classic modal
 * and the flat v2 view: one holder object instead of nine parallel
 * nullable fields, with a single destroy() for the composer teardown
 * (identical semantics to the previous inline cleanup blocks).
 */
export class ComposerControls {
  relaySelector: RelaySelector | null = null;
  clientTagControl: ClientTagControl | null = null;
  toolbar: PostEditorToolbar | null = null;
  nsfwSwitch: Switch | null = null;
  expiryDropdown: NnDropdown | null = null;
  mentionAutocomplete: MentionAutocomplete | null = null;
  customEmojiAutocomplete:
    | import('../../addons/custom-emojis/CustomEmojiAutocomplete').CustomEmojiAutocomplete
    | null = null;
  customEmojiService:
    | import('../../addons/custom-emojis/EmojiService').EmojiService
    | null = null;
  eventHandlerManager: ModalEventHandlerManager | null = null;

  /** Destroy every mounted component and null its reference. */
  destroy(): void {
    destroyComposerControls(this);
    this.relaySelector = null;
    this.clientTagControl = null;
    this.toolbar = null;
    this.nsfwSwitch = null;
    this.expiryDropdown = null;
    this.mentionAutocomplete = null;
    this.customEmojiAutocomplete = null;
    this.customEmojiService = null;
  }
}
