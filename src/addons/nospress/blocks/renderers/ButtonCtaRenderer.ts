import { sanitizeUserHtml } from '../../../../helpers/sanitizeUserHtml';
import { sanitizeUrl } from '../../../../helpers/sanitizeUrl';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import { styleWrap } from '../styles';
import type { Block } from '../types';

/**
 * Button CTA block — call-to-action button linking to any URL.
 *
 * Editable: label + url inputs + variant dropdown.
 * Readonly: <a class="btn …" target="_blank"> centered in a wrapper. The
 * `variant` controls primary (.btn) vs secondary (.btn.btn--passive)
 * styling; users can further customize via the style matrix.
 */
export function renderButtonCta(block: Extract<Block, { type: 'button-cta' }>, editable = false): string {
  const variant = block.variant ?? 'primary';

  if (editable) {
    const labelInput = `<input type="text" class="input nospress-block-button-cta__label-input" data-block-id="${block.id}" data-field="cta-label" value="${escapeHtmlAttr(block.label || '')}" placeholder="Button label" />`;
    const urlInput = `<input type="url" class="input nospress-block-button-cta__url-input" data-block-id="${block.id}" data-field="cta-url" value="${escapeHtmlAttr(block.url || '')}" placeholder="https://…" />`;
    const variantSelect = `
      <select class="input nospress-block-button-cta__variant-select" data-block-id="${block.id}" data-field="cta-variant">
        <option value="primary" ${variant === 'primary' ? 'selected' : ''}>Primary</option>
        <option value="secondary" ${variant === 'secondary' ? 'selected' : ''}>Secondary</option>
      </select>
    `;
    return wrapEditable(block.id, 'button-cta', `${labelInput}${urlInput}${variantSelect}`);
  }

  const label = sanitizeUserHtml((block.label || '').trim() || 'Click me');
  const safeUrl = sanitizeUrl(block.url);
  const btnClass = variant === 'secondary' ? 'btn btn--passive' : 'btn';

  const inner = safeUrl
    ? `<a class="${btnClass}" href="${escapeHtmlAttr(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : `<button type="button" class="${btnClass}" disabled>${label}</button>`;
  return styleWrap(block, inner, { tag: 'div', baseClass: 'nospress-block-button-cta' });
}
