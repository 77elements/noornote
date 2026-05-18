/**
 * Card block — `.nn-card` molecule wrapper around a media slot plus a
 * stack of nested child blocks.
 *
 * Readonly: image (optional) + recursively-rendered children body.
 * Editable: image URL input + Upload button + alt-text input + children
 *   slot — NospressView fills the slot via `renderCardBlockEditable`
 *   (mirrors the div-block cursor-injection pattern).
 *
 * The slot exposes `data-card-block-id` so NospressView can attach the
 * empty-children placeholder + paste-here button handlers.
 */

import { BlockRenderer } from '../BlockRenderer';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { sanitizeUrl } from '../../../../helpers/sanitizeUrl';
import { wrapEditable } from './blockEditWrapper';
import { styleWrap } from '../styles';
import type { Block } from '../types';

export interface RenderCardOptions {
  editable?: boolean;
  /** Editable mode: NospressView injects the recursive cursor-aware
   *  child render output here. */
  childrenInner?: () => string;
}

export function renderCard(
  block: Extract<Block, { type: 'card' }>,
  opts: RenderCardOptions = {}
): string {
  const editable = opts.editable === true;

  if (editable) {
    const safeUrl = sanitizeUrl(block.image ?? '');
    const childrenHtml = opts.childrenInner ? opts.childrenInner() : '';
    const inner = `
      <div class="nospress-block-card__edit">
        <div class="form__row">
          <label>Cover image URL (optional)</label>
          <div class="nospress-block-image__url-row">
            <input type="url" class="input" data-block-id="${block.id}" data-field="card-image" value="${escapeHtmlAttr(block.image ?? '')}" placeholder="https://... or upload" />
            <button type="button" class="btn-icon" data-block-id="${block.id}" data-action="upload-card-image" title="Upload cover image">
              <svg width="18" height="18"><use href="#icon-upload"/></svg>
            </button>
            <input type="file" accept="image/*" data-block-id="${block.id}" data-card-image-file style="display: none;" />
          </div>
        </div>
        <div class="form__row">
          <label>Alt text (accessibility)</label>
          <input type="text" class="input" data-block-id="${block.id}" data-field="card-image-alt" value="${escapeHtmlAttr(block.imageAlt ?? '')}" placeholder="Describe the image..." />
        </div>
        ${safeUrl ? `
          <div class="nospress-block-image__preview">
            <img src="${escapeHtmlAttr(safeUrl)}" alt="${escapeHtmlAttr(block.imageAlt ?? '')}" />
          </div>
        ` : ''}
        <div class="nospress-block-card__children" data-card-block-id="${block.id}">${childrenHtml}</div>
      </div>
    `;
    return wrapEditable(block.id, 'card', inner);
  }

  // Public render — `.nn-card` molecule. styleWrap puts the user's
  // block-level style on the outer `<div class="nn-card">`, so margin /
  // padding / border-radius overrides land where the molecule expects.
  const safeUrl = sanitizeUrl(block.image ?? '');
  const mediaHtml = safeUrl
    ? `<div class="nn-card__media"><img src="${escapeHtmlAttr(safeUrl)}" alt="${escapeHtmlAttr(block.imageAlt ?? '')}" /></div>`
    : '';
  const childrenHtml = BlockRenderer.renderAll(block.children, { editable: false });
  const contentHtml = childrenHtml
    ? `<div class="nn-card__content">${childrenHtml}</div>`
    : '';

  return styleWrap(
    block,
    `${mediaHtml}${contentHtml}`,
    { tag: 'div', baseClass: 'nn-card nospress-block-card' },
  );
}
