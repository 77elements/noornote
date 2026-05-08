import { sanitizeUserHtml } from '../../../../helpers/sanitizeUserHtml';
import { escapeHtml } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import { styleWrap } from '../styles';
import type { Block } from '../types';

export function renderText(block: Extract<Block, { type: 'text' }>, editable = false): string {
  if (editable) {
    const inner = `<textarea class="nospress-block-text__input textarea textarea--small" data-block-id="${block.id}" data-field="content" placeholder="Text content...">${escapeHtml(block.content)}</textarea>`;
    const linkBtn = `
      <button type="button" class="nospress-block-edit__btn" data-block-id="${block.id}" data-action="insert-link" title="Insert link" aria-label="Insert link">
        <svg width="14" height="14"><use href="#icon-link"/></svg>
      </button>
    `;
    return wrapEditable(block.id, 'text', inner, linkBtn);
  }
  // Readonly: self-wrap so styles land on the `<p>` directly — same reason
  // as Heading (avoid the wrapper-div indirection where inheritable
  // properties get shadowed by the inner element's defaults).
  const content = sanitizeUserHtml(block.content);
  return styleWrap(block, content, { tag: 'p', baseClass: 'nospress-block-text' });
}
