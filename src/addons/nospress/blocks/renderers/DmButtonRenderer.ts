import { sanitizeUserHtml } from '../../../../helpers/sanitizeUserHtml';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import type { Block } from '../types';

export function renderDmButton(block: Extract<Block, { type: 'dm-button' }>, editable = false): string {
  if (editable) {
    const labelInput = `<input type="text" class="input" data-block-id="${block.id}" data-field="dm-label" value="${escapeHtmlAttr(block.label || '')}" placeholder="Send me a message" />`;
    const hint = `<small class="nospress-block-dm-button__hint">Opens a DM to the page owner.</small>`;
    return wrapEditable(block.id, 'dm-button', `${labelInput}${hint}`);
  }

  const label = sanitizeUserHtml((block.label || '').trim() || 'Send me a message');
  return `<div class="nospress-block-dm-button"><button type="button" class="btn" data-action="dm-page-owner">${label}</button></div>`;
}
