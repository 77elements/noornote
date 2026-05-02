import DOMPurify from 'dompurify';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import type { Block } from '../types';

/**
 * Video block — single video with optional caption + poster thumbnail.
 *
 * Editable: URL input + upload button (analog to ImageRenderer) + caption
 * + poster URL inputs.
 * Readonly: native `<video controls preload="metadata">` with `note-video`
 * class so the global VideoPlayerService picks it up (download button +
 * auto-pause across the app).
 *
 * V1 — no hls.js / m3u8 streams, no YouTube/Vimeo embeds. The hls bundle
 * exists in the repo (live-streams-player addon) and can be wired in
 * later if a use-case appears.
 */
export function renderVideo(block: Extract<Block, { type: 'video' }>, editable = false): string {
  if (editable) {
    const inner = `
      <div class="nospress-block-video__edit">
        <div class="form__row">
          <label>Video URL</label>
          <div class="nospress-block-video__url-row">
            <input type="url" class="input" data-block-id="${block.id}" data-field="video-url" value="${escapeHtmlAttr(block.url)}" placeholder="https://… (mp4 / webm)" />
            <button type="button" class="btn-icon" data-block-id="${block.id}" data-action="upload-video" title="Upload video">
              <svg width="18" height="18"><use href="#icon-upload"/></svg>
            </button>
            <input type="file" accept="video/*" data-block-id="${block.id}" data-video-file style="display: none;" />
          </div>
        </div>
        <div class="form__row">
          <label>Caption (optional)</label>
          <input type="text" class="input" data-block-id="${block.id}" data-field="video-caption" value="${escapeHtmlAttr(block.caption || '')}" placeholder="Caption shown below the video…" />
        </div>
        <div class="form__row">
          <label>Poster image URL (optional)</label>
          <input type="url" class="input" data-block-id="${block.id}" data-field="video-poster" value="${escapeHtmlAttr(block.poster || '')}" placeholder="Thumbnail shown before play…" />
        </div>
        ${block.url ? `
          <div class="nospress-block-video__preview">
            <video class="note-video" controls preload="metadata" src="${escapeHtmlAttr(block.url)}"${block.poster ? ` poster="${escapeHtmlAttr(block.poster)}"` : ''}></video>
          </div>
        ` : ''}
      </div>
    `;
    return wrapEditable(block.id, 'video', inner);
  }

  if (!block.url?.trim()) return '';

  const captionHtml = block.caption?.trim()
    ? `<figcaption class="nospress-block-video__caption">${DOMPurify.sanitize(block.caption)}</figcaption>`
    : '';
  const posterAttr = block.poster?.trim() ? ` poster="${escapeHtmlAttr(block.poster)}"` : '';

  return `<figure class="nospress-block-video">
    <video class="note-video" controls preload="metadata" src="${escapeHtmlAttr(block.url)}"${posterAttr}></video>
    ${captionHtml}
  </figure>`;
}
