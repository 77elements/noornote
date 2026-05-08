import { sanitizeUserHtml } from '../../../../helpers/sanitizeUserHtml';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import { styleWrap } from '../styles';
import type { Block } from '../types';

export function renderHeading(block: Extract<Block, { type: 'heading' }>, editable = false): string {
  if (editable) {
    const value = escapeHtmlAttr(block.text);
    const inner = `
      <div class="nospress-block-heading__level-slot" data-block-dropdown="heading-level" data-block-id="${block.id}" data-current-value="${block.level}"></div>
      <input type="text" class="nospress-block-heading__input input" data-block-id="${block.id}" data-field="text" value="${value}" placeholder="Heading text..." />
    `;
    const linkBtn = `
      <button type="button" class="nospress-block-edit__btn" data-block-id="${block.id}" data-action="insert-link" title="Insert link" aria-label="Insert link">
        <svg width="14" height="14"><use href="#icon-link"/></svg>
      </button>
    `;
    return wrapEditable(block.id, 'heading', inner, linkBtn);
  }
  // Readonly: self-wrap so the user's `style` payload lands directly on
  // the `<h1/2/3>` element. Without this an extra wrapper div would
  // shadow the heading's own browser-default font-size (h1 is `2em`,
  // relative to its parent — so font-size on the wrapper would never
  // override the heading's size).
  const text = sanitizeUserHtml(block.text);
  const tag = `h${block.level}`;
  return styleWrap(block, text, { tag, baseClass: `nospress-block-heading nospress-block-heading--h${block.level}` });
}
