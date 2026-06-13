/**
 * Shared Edit/Preview tab-switch skeleton for the note & reply composers.
 * Per-composer bits (modal selector, editor/preview HTML, post-render hooks)
 * are passed in. Returns false if the modal/header/actions aren't present.
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
}

export function switchComposerTab(opts: SwitchComposerTabOptions): boolean {
  const modal = document.querySelector(opts.modalSelector);
  if (!modal) return false;

  const header = modal.querySelector('.post-note-header');
  const actions = modal.querySelector('.l-row--split');
  if (!header || !actions) return false;

  const oldEditor = modal.querySelector('.textarea') || modal.querySelector('.post-note-preview');
  if (oldEditor) oldEditor.remove();

  if (opts.tab === 'edit') {
    actions.insertAdjacentHTML('beforebegin', opts.renderEditorHtml());
    opts.onEditRendered?.();
  } else {
    const previewContainer = document.createElement('div');
    previewContainer.className = 'post-note-preview';
    previewContainer.innerHTML = opts.buildPreviewHtml();
    actions.parentNode?.insertBefore(previewContainer, actions);
    opts.onPreviewRendered?.(previewContainer);
  }

  return true;
}
