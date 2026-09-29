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
import { RelaySelector } from './RelaySelector';
import { renderDraftsList, setupDraftsList } from './DraftsListUI';
import { Switch } from '../ui/Switch';
import { MentionAutocomplete } from '../mentions/MentionAutocomplete';
import { renderPostPreview } from '../../helpers/renderPostPreview';
import { stripTrackingParams } from '../../helpers/stripTrackingParams';
import { SystemLogger } from '../../services/SystemLogger';

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
    ToastService.show('Nothing to save', 'info');
    return;
  }
  NoteDraftService.getInstance().add({
    type: opts.draftType,
    content,
    failed: false,
    ...(opts.parentEventId ? { parentEventId: opts.parentEventId } : {}),
    ...(opts.contextLabel ? { contextLabel: opts.contextLabel } : {}),
  });
  ToastService.show('Draft saved', 'success');
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
    label: 'Open drafts',
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
  currentUserPubkey: string
): void {
  EditorStateManager.updatePreview('.post-note-preview', {
    content: stripTrackingParams(content),
    pubkey: currentUserPubkey,
    isNSFW,
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
