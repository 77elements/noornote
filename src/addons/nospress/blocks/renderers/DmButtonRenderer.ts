import { sanitizeUserHtml } from '../../../../helpers/sanitizeUserHtml';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import { styleWrap, sanitizeStyleValue } from '../styles';
import type { Block } from '../types';

export function renderDmButton(block: Extract<Block, { type: 'dm-button' }>, editable = false): string {
  if (editable) {
    const labelInput = `<input type="text" class="input" data-block-id="${block.id}" data-field="dm-label" value="${escapeHtmlAttr(block.label || '')}" placeholder="Send me a message" />`;
    const hint = `<small class="nospress-block-dm-button__hint">Opens a DM to the page owner.</small>`;
    return wrapEditable(block.id, 'dm-button', `${labelInput}${hint}`);
  }

  const label = sanitizeUserHtml((block.label || '').trim() || 'Send me a message');
  const buttonHtml = styleWrap(
    block,
    label,
    {
      tag: 'button',
      baseClass: 'nospress-block-dm-button btn',
      extraAttrs: 'type="button" data-action="dm-page-owner"',
    },
  );

  // `alignButton` lives on the block's style payload but is suppressed
  // from the button's inline style (skipInlineEmit on the catalog entry).
  // It only renders as `text-align` on an outer wrapper DIV so the
  // inline-flex button can be positioned left / center / right within
  // its parent.
  const align = sanitizeStyleValue(block.style?.alignButton ?? '');
  if (!align) return buttonHtml;
  return `<div class="nospress-block-dm-button-align" style="text-align: ${align}">${buttonHtml}</div>`;
}
