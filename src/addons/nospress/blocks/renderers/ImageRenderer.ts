import { sanitizeUserHtml } from '../../../../helpers/sanitizeUserHtml';
import { sanitizeUrl } from '../../../../helpers/sanitizeUrl';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { buildLightboxImagesHtml } from '../../../../helpers/lightboxImages';
import { wrapEditable } from './blockEditWrapper';
import { styleWrap } from '../styles';
import type { Block } from '../types';

export function renderImage(block: Extract<Block, { type: 'image' }>, editable = false): string {
  const safeUrl = sanitizeUrl(block.url);

  if (editable) {
    const inner = `
      <div class="nospress-block-image__edit">
        <div class="form__row">
          <label>Image URL</label>
          <div class="nospress-block-image__url-row">
            <input type="url" class="input" data-block-id="${block.id}" data-field="url" value="${escapeHtmlAttr(block.url)}" placeholder="https://... or upload" />
            <button type="button" class="btn-icon" data-block-id="${block.id}" data-action="upload-image" title="Upload image">
              <svg width="18" height="18"><use href="#icon-upload"/></svg>
            </button>
            <input type="file" accept="image/*" data-block-id="${block.id}" data-image-file style="display: none;" />
          </div>
        </div>
        <div class="form__row">
          <label>Alt text (accessibility)</label>
          <input type="text" class="input" data-block-id="${block.id}" data-field="alt" value="${escapeHtmlAttr(block.alt || '')}" placeholder="Describe the image..." />
        </div>
        <div class="form__row">
          <label>Caption (optional)</label>
          <input type="text" class="input" data-block-id="${block.id}" data-field="caption" value="${escapeHtmlAttr(block.caption || '')}" placeholder="Caption shown below the image..." />
        </div>
        ${safeUrl ? `
          <div class="nospress-block-image__preview">
            <img src="${escapeHtmlAttr(safeUrl)}" alt="${escapeHtmlAttr(block.alt || '')}" />
          </div>
        ` : ''}
      </div>
    `;
    return wrapEditable(block.id, 'image', inner);
  }

  if (!safeUrl) return '';

  const captionHtml = block.caption?.trim()
    ? `<figcaption class="nospress-block-image__caption">${sanitizeUserHtml(block.caption)}</figcaption>`
    : '';
  const { imagesHtml, containerDataAttr } = buildLightboxImagesHtml([safeUrl], { alts: [block.alt ?? ''] });
  return styleWrap(
    block,
    `${imagesHtml}${captionHtml}`,
    { tag: 'figure', baseClass: 'nospress-block-image note-media', extraAttrs: containerDataAttr },
  );
}
