/**
 * Shared Edit/Preview/Drafts tab-switch skeleton for the note & reply composers.
 * Per-composer bits (modal selector, editor/preview/drafts HTML, post-render
 * hooks) are passed in. Returns false if the modal/header/actions aren't present.
 */

import type { TabMode } from '../components/modals/ModalEventHandlerManager';

export interface SwitchComposerTabOptions {
  modalSelector: string;
  tab: TabMode;
  /** Editor HTML, inserted before the actions row in edit mode. */
  renderEditorHtml: () => string;
  /** Called after the editor HTML is inserted (e.g. refresh textarea listener). */
  onEditRendered?: () => void;
  /** Inner HTML for the `.post-note-preview` container in preview mode. */
  buildPreviewHtml: () => string;
  /** Called with the inserted preview container (e.g. render quoted notes). */
  onPreviewRendered?: (previewContainer: HTMLElement) => void;
  /** Inner HTML for the `.post-note-drafts` container in drafts mode. */
  renderDraftsHtml?: () => string;
  /** Called with the inserted drafts container (wire delete/open handlers). */
  onDraftsRendered?: (draftsContainer: HTMLElement) => void;
}

export function switchComposerTab(opts: SwitchComposerTabOptions): boolean {
  const modal = document.querySelector(opts.modalSelector);
  if (!modal) return false;

  const header = modal.querySelector('.post-note-header');
  const actions = modal.querySelector('.l-row--split');
  if (!header || !actions) return false;

  const oldBody =
    modal.querySelector('.textarea') ||
    modal.querySelector('.post-note-preview') ||
    modal.querySelector('.post-note-drafts');
  if (oldBody) oldBody.remove();

  if (opts.tab === 'edit') {
    actions.insertAdjacentHTML('beforebegin', opts.renderEditorHtml());
    opts.onEditRendered?.();
  } else if (opts.tab === 'drafts') {
    const draftsContainer = document.createElement('div');
    draftsContainer.className = 'post-note-drafts';
    draftsContainer.innerHTML = opts.renderDraftsHtml?.() ?? '';
    actions.parentNode?.insertBefore(draftsContainer, actions);
    opts.onDraftsRendered?.(draftsContainer);
  } else {
    const previewContainer = document.createElement('div');
    previewContainer.className = 'post-note-preview';
    previewContainer.innerHTML = opts.buildPreviewHtml();
    actions.parentNode?.insertBefore(previewContainer, actions);
    opts.onPreviewRendered?.(previewContainer);
  }

  return true;
}
