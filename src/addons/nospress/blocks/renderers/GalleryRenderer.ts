import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { buildLightboxImagesHtml } from '../../../../helpers/lightboxImages';
import { wrapEditable } from './blockEditWrapper';
import { styleWrap } from '../styles';
import type { Block } from '../types';

/**
 * Pick the same grid modifier as `renderMediaContent.ts` so a Gallery block
 * looks identical to inline-media in regular notes:
 *   2 → grid-2 (2 cols), 3 → grid-3 (3 cols),
 *   4 → grid-2x2,         5+ → grid-3-cols (3 cols flowing).
 */
function gridModifierFor(count: number): string {
  if (count === 2) return ' note-media--grid-2';
  if (count === 3) return ' note-media--grid-3';
  if (count === 4) return ' note-media--grid-2x2';
  if (count >= 5) return ' note-media--grid-3-cols';
  return '';
}

export function renderGallery(block: Extract<Block, { type: 'gallery' }>, editable = false): string {
  if (editable) {
    const itemsHtml = block.urls.map((url, i) => `
      <div class="nospress-block-gallery__item-row" data-item-index="${i}">
        <input type="url" class="input nospress-block-gallery__url-input" data-block-id="${block.id}" data-field="gallery-url" data-item-index="${i}" value="${escapeHtmlAttr(url)}" placeholder="https://..." />
        ${url ? `<img class="nospress-block-gallery__thumb" src="${escapeHtmlAttr(url)}" alt="" />` : ''}
        <button type="button" class="nospress-block-edit__btn nospress-block-edit__btn--danger" data-block-id="${block.id}" data-action="delete-gallery-url" data-item-index="${i}" title="Remove" aria-label="Remove">
          <svg width="14" height="14"><use href="#icon-close"/></svg>
        </button>
      </div>
    `).join('');
    const addRow = `
      <div class="nospress-block-gallery__add-row">
        <button type="button" class="btn btn--passive btn--mini" data-block-id="${block.id}" data-action="add-gallery-url">+ Add URL</button>
        <button type="button" class="btn btn--passive btn--mini" data-block-id="${block.id}" data-action="upload-gallery-images">↑ Upload images</button>
        <input type="file" accept="image/*" multiple data-block-id="${block.id}" data-gallery-files style="display: none;" />
      </div>
    `;
    return wrapEditable(block.id, 'gallery', `<div class="nospress-block-gallery__items-edit">${itemsHtml}</div>${addRow}`);
  }

  const validUrls = block.urls.filter(u => u?.trim());
  if (validUrls.length === 0) return '';

  const grid = gridModifierFor(validUrls.length);
  const { imagesHtml, containerDataAttr } = buildLightboxImagesHtml(validUrls);
  return styleWrap(
    block,
    imagesHtml,
    { tag: 'div', baseClass: `note-media${grid} nospress-block-gallery`, extraAttrs: containerDataAttr },
  );
}
