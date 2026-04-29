import DOMPurify from 'dompurify';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import type { Block } from '../types';

export function renderHeading(block: Extract<Block, { type: 'heading' }>, editable = false): string {
  if (editable) {
    const value = escapeHtmlAttr(block.text);
    const inner = `
      <select class="mypage-block-heading__level-select" data-block-id="${block.id}" data-field="level">
        ${[1, 2, 3].map(l => `<option value="${l}"${block.level === l ? ' selected' : ''}>H${l}</option>`).join('')}
      </select>
      <input type="text" class="mypage-block-heading__input input" data-block-id="${block.id}" data-field="text" value="${value}" placeholder="Heading text..." />
    `;
    return wrapEditable(block.id, 'heading', inner);
  }
  const text = DOMPurify.sanitize(block.text || '');
  return `<h${block.level} class="mypage-block-heading mypage-block-heading--h${block.level}">${text}</h${block.level}>`;
}
