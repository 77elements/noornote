/**
 * DraftsListUI - shared renderer + event wiring for the composer "Drafts" tab.
 * Used by both PostNoteModal and ReplyModal so the list looks and behaves
 * identically wherever it is shown.
 */

import {
  NoteDraftService,
  type NoteDraft,
} from '../../services/NoteDraftService';
import { formatTimeAgo } from '../../helpers/formatTimeAgo';
import { escapeHtml } from '../../helpers/escapeHtml';

export interface DraftsListCallbacks {
  /** Reopen the draft in the appropriate composer. */
  onOpen: (draft: NoteDraft) => void;
  /** Fired after a delete so the caller can refresh its tab badge. */
  onChanged: () => void;
}

function truncate(text: string, max = 140): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Build the Drafts tab body (a `.ui-list` of all drafts, newest first). */
export function renderDraftsList(): string {
  const drafts = NoteDraftService.getInstance().list();
  if (drafts.length === 0) {
    return `<div class="note-drafts__empty">No drafts yet</div>`;
  }

  const items = drafts
    .map(d => {
      const text = escapeHtml(truncate(d.content));
      return `
      <div class="ui-list__item ui-list__item--clickable note-draft" data-draft-id="${escapeHtml(d.id)}">
        <div class="note-draft__main">
          <div class="note-draft__meta">
            <span class="note-draft__time">${escapeHtml(formatTimeAgo(d.createdAt))}</span>
            ${d.failed ? `<span class="badge badge--danger">Failed</span>` : ''}
            ${d.contextLabel ? `<span class="note-draft__context">${escapeHtml(d.contextLabel)}</span>` : ''}
          </div>
          <div class="note-draft__text">${text || '<em>(empty)</em>'}</div>
          ${d.failed && d.failureReason ? `<div class="note-draft__reason">${escapeHtml(d.failureReason)}</div>` : ''}
        </div>
        <button class="btn-icon note-draft__delete" data-draft-delete aria-label="Delete draft">
          <svg width="18" height="18"><use href="#icon-trash"/></svg>
        </button>
      </div>
    `;
    })
    .join('');

  return `<div class="ui-list note-drafts__list">${items}</div>`;
}

/** Wire one delegated click handler for open + delete on the drafts container. */
export function setupDraftsList(
  container: HTMLElement,
  cb: DraftsListCallbacks
): void {
  container.addEventListener('click', e => {
    const targetEl = e.target as HTMLElement;
    const item = targetEl.closest('[data-draft-id]') as HTMLElement | null;
    if (!item) return;

    const id = item.getAttribute('data-draft-id');
    if (!id) return;

    if (targetEl.closest('[data-draft-delete]')) {
      e.stopPropagation();
      NoteDraftService.getInstance().remove(id);
      container.innerHTML = renderDraftsList();
      cb.onChanged();
      return;
    }

    const draft = NoteDraftService.getInstance()
      .list()
      .find(d => d.id === id);
    if (draft) cb.onOpen(draft);
  });
}
