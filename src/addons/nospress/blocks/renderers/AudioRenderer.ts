import { sanitizeUserHtml } from '../../../../helpers/sanitizeUserHtml';
import { sanitizeUrl } from '../../../../helpers/sanitizeUrl';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import { styleWrap } from '../styles';
import type { Block } from '../types';

/**
 * Audio block — single audio player with optional caption.
 *
 * Editable: URL input + upload button + caption input.
 * Readonly: native `<audio controls preload="metadata">` with `note-audio`
 * class so it picks up the same styling used elsewhere in the app.
 */
export function renderAudio(block: Extract<Block, { type: 'audio' }>, editable = false): string {
  const safeUrl = sanitizeUrl(block.url);

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
        ${safeUrl ? `
          <div class="nospress-block-audio__preview">
            <audio class="note-audio" controls preload="metadata" src="${escapeHtmlAttr(safeUrl)}"></audio>
          </div>
        ` : ''}
      </div>
    `;
    return wrapEditable(block.id, 'audio', inner);
  }

  if (!safeUrl) return '';

  const captionHtml = block.caption?.trim()
    ? `<figcaption class="nospress-block-audio__caption">${sanitizeUserHtml(block.caption)}</figcaption>`
    : '';

  return styleWrap(
    block,
    `<audio class="note-audio" controls preload="metadata" src="${escapeHtmlAttr(safeUrl)}"></audio>${captionHtml}`,
    { tag: 'figure', baseClass: 'nospress-block-audio' },
  );
}
