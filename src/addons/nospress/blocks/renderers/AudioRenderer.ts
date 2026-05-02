import DOMPurify from 'dompurify';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import type { Block } from '../types';

/**
 * Audio block — single audio player with optional caption.
 *
 * Editable: URL input + upload button + caption input.
 * Readonly: native `<audio controls preload="metadata">` with `note-audio`
 * class so it picks up the same styling used elsewhere in the app.
 */
export function renderAudio(block: Extract<Block, { type: 'audio' }>, editable = false): string {
  if (editable) {
    const inner = `
      <div class="nospress-block-audio__edit">
        <div class="form__row">
          <label>Audio URL</label>
          <div class="nospress-block-audio__url-row">
            <input type="url" class="input" data-block-id="${block.id}" data-field="audio-url" value="${escapeHtmlAttr(block.url)}" placeholder="https://… (mp3 / ogg / wav / m4a)" />
            <button type="button" class="btn-icon" data-block-id="${block.id}" data-action="upload-audio" title="Upload audio">
              <svg width="18" height="18"><use href="#icon-upload"/></svg>
            </button>
            <input type="file" accept="audio/*" data-block-id="${block.id}" data-audio-file style="display: none;" />
          </div>
        </div>
        <div class="form__row">
          <label>Caption (optional)</label>
          <input type="text" class="input" data-block-id="${block.id}" data-field="audio-caption" value="${escapeHtmlAttr(block.caption || '')}" placeholder="Caption shown below the player…" />
        </div>
        ${block.url ? `
          <div class="nospress-block-audio__preview">
            <audio class="note-audio" controls preload="metadata" src="${escapeHtmlAttr(block.url)}"></audio>
          </div>
        ` : ''}
      </div>
    `;
    return wrapEditable(block.id, 'audio', inner);
  }

  if (!block.url?.trim()) return '';

  const captionHtml = block.caption?.trim()
    ? `<figcaption class="nospress-block-audio__caption">${DOMPurify.sanitize(block.caption)}</figcaption>`
    : '';

  return `<figure class="nospress-block-audio">
    <audio class="note-audio" controls preload="metadata" src="${escapeHtmlAttr(block.url)}"></audio>
    ${captionHtml}
  </figure>`;
}
