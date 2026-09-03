/**
 * Composer shared blocks — the byte-identical plumbing between
 * PostNoteModal and ReplyModal (drafts tab badge, tab switching, draft
 * saving, publish-failure recovery, quote-preview injection).
 *
 * Deliberately FUNCTIONS, not a base class: the two modals are divergent
 * singletons (visibility/geo/schedule/poll/tag-overlays vs parent-event
 * kind-switching) — parameterizing the identical blocks keeps them thin
 * without forcing a fragile generic over the differing parts.
 */

import { NoteDraftService } from '../../services/NoteDraftService';
import { ToastService } from '../../services/ToastService';
import { ModalEventHandlerManager } from '../modals/ModalEventHandlerManager';
import { SignerTimeoutError } from '../../services/SignerTimeoutError';
import { extractQuotedReferences } from '../../helpers/extractQuotedReferences';
import { renderQuotePreview } from '../../helpers/renderQuotePreview';

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
