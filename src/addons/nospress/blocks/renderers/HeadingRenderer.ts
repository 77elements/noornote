import { sanitizeUserHtml } from '../../../../helpers/sanitizeUserHtml';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import type { Block } from '../types';

export function renderHeading(block: Extract<Block, { type: 'heading' }>, editable = false): string {
  if (editable) {
    const value = escapeHtmlAttr(block.text);
    const inner = `
      <div class="nospress-block-heading__level-slot" data-block-dropdown="heading-level" data-block-id="${block.id}" data-current-value="${block.level}"></div>
      <input type="text" class="nospress-block-heading__input input" data-block-id="${block.id}" data-field="text" value="${value}" placeholder="Heading text..." />
    `;
    return wrapEditable(block.id, 'heading', inner);
  }
  const text = sanitizeUserHtml(block.text);
  return `<h${block.level} class="nospress-block-heading nospress-block-heading--h${block.level}">${text}</h${block.level}>`;
}
