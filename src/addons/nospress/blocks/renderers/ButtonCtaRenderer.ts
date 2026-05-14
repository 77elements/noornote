import { sanitizeUserHtml } from '../../../../helpers/sanitizeUserHtml';
import { sanitizeUrl } from '../../../../helpers/sanitizeUrl';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import { styleWrap, sanitizeStyleValue } from '../styles';
import type { Block } from '../types';

/**
 * Button CTA block — call-to-action button linking to any URL.
 *
 * Editable: label + url inputs + variant dropdown + target dropdown.
 * Readonly: <a class="btn …" target="_blank|_self"> centered in a wrapper.
 * The `variant` controls primary (.btn) vs secondary (.btn.btn--passive)
 * styling; `target` picks between new tab (`_blank`, default — keeps
 * visitors on the site for external links) and same tab (`_self` — right
 * for internal links to own pages); users can further customize via the
 * style matrix.
 */
export function renderButtonCta(block: Extract<Block, { type: 'button-cta' }>, editable = false): string {
  const variant = block.variant ?? 'primary';
  // Default mirrors the pre-target behavior — new tab — so legacy blocks
  // without the field keep their existing render.
  const target = block.target === '_self' ? '_self' : '_blank';

  if (editable) {
    const labelInput = `<input type="text" class="input nospress-block-button-cta__label-input" data-block-id="${block.id}" data-field="cta-label" value="${escapeHtmlAttr(block.label || '')}" placeholder="Button label" />`;
    const urlInput = `<input type="url" class="input nospress-block-button-cta__url-input" data-block-id="${block.id}" data-field="cta-url" value="${escapeHtmlAttr(block.url || '')}" placeholder="https://…" />`;
    // CustomDropdown slots — populated by NospressView.mountBlockDropdowns
    // (cases 'cta-variant' / 'cta-target'). App-wide rule: never raw `<select>`.
    const variantSlot = `<div data-block-dropdown="cta-variant" data-block-id="${block.id}" data-current-value="${escapeHtmlAttr(variant)}"></div>`;
    const targetSlot = `<div data-block-dropdown="cta-target" data-block-id="${block.id}" data-current-value="${escapeHtmlAttr(target)}"></div>`;
    return wrapEditable(block.id, 'button-cta', `${labelInput}${urlInput}${variantSlot}${targetSlot}`);
  }

  const label = sanitizeUserHtml((block.label || '').trim() || 'Click me');
  const safeUrl = sanitizeUrl(block.url);
  const btnClass = variant === 'secondary' ? 'btn btn--passive' : 'btn';

  // `rel="noopener noreferrer"` is only needed for `_blank` — its purpose
  // is to sever the window.opener back-reference that same-tab navigation
  // doesn't create in the first place.
  const relAttr = target === '_blank' ? ' rel="noopener noreferrer"' : '';
  const inner = safeUrl
    ? `<a class="${btnClass}" href="${escapeHtmlAttr(safeUrl)}" target="${target}"${relAttr}>${label}</a>`
    : `<button type="button" class="${btnClass}" disabled>${label}</button>`;

  // `alignButton` is `skipInlineEmit: true` in the catalog so the regular
  // emit pipeline skips it. We pipe it through `extraInlineStyle` so it
  // lands as `text-align: …` directly on `.nospress-block-button-cta`,
  // which wraps the inline-block `.btn` child — plain text-align does
  // the left / center / right placement, no flex needed.
  const align = sanitizeStyleValue(block.style?.alignButton ?? '');
  const extraInlineStyle = align ? `text-align: ${align}` : '';
  return styleWrap(block, inner, {
    tag: 'div',
    baseClass: 'nospress-block-button-cta',
    extraInlineStyle,
  });
}
