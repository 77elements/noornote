import DOMPurify from 'dompurify';
import { escapeHtml } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import type { Block } from '../types';

export function renderText(block: Extract<Block, { type: 'text' }>, editable = false): string {
  if (editable) {
    const inner = `<textarea class="nospress-block-text__input textarea textarea--small" data-block-id="${block.id}" data-field="content" placeholder="Text content...">${escapeHtml(block.content)}</textarea>`;
    return wrapEditable(block.id, 'text', inner);
  }
  const content = DOMPurify.sanitize(block.content || '');
  return `<p class="nospress-block-text">${content}</p>`;
}
