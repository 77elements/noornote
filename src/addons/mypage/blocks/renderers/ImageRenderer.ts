import DOMPurify from 'dompurify';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { buildLightboxImagesHtml } from '../../../../helpers/lightboxImages';
import { wrapEditable } from './blockEditWrapper';
import type { Block } from '../types';

export function renderImage(block: Extract<Block, { type: 'image' }>, editable = false): string {
  if (editable) {
    const inner = `
      <div class="mypage-block-image__edit">
        <div class="form__row">
          <label>Image URL</label>
          <div class="mypage-block-image__url-row">
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
        ${block.url ? `
          <div class="mypage-block-image__preview">
            <img src="${escapeHtmlAttr(block.url)}" alt="${escapeHtmlAttr(block.alt || '')}" />
          </div>
        ` : ''}
      </div>
    `;
    return wrapEditable(block.id, 'image', inner);
  }

  if (!block.url?.trim()) return '';

  const captionHtml = block.caption?.trim()
    ? `<figcaption class="mypage-block-image__caption">${DOMPurify.sanitize(block.caption)}</figcaption>`
    : '';
  const { imagesHtml, containerDataAttr } = buildLightboxImagesHtml([block.url], { alts: [block.alt ?? ''] });
  return `
    <figure class="mypage-block-image note-media" ${containerDataAttr}>
      ${imagesHtml}
      ${captionHtml}
    </figure>
  `;
}
