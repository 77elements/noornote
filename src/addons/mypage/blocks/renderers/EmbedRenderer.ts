import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import type { Block } from '../types';

/**
 * EmbedRenderer
 *
 * Editable: a single input for the nostr reference (`nostr:nevent1…` /
 * `nevent1…` / `note1…` / `naddr1…`). The MypageView event delegation
 * persists changes silently (debounced) — no live preview during typing.
 *
 * Readonly: emits a placeholder div with `data-embed-mount` carrying the
 * block id + raw nostrRef. MypageView walks these slots after innerHTML,
 * decodes/fetches the event, and mounts a NoteUI element in place — same
 * pipeline that powers timeline notes, so ISL + reactions work for free.
 *
 * Empty refs render nothing in readonly mode.
 */
export function renderEmbed(block: Extract<Block, { type: 'embed' }>, editable = false): string {
  if (editable) {
    const inner = `
      <div class="mypage-block-embed__edit">
        <div class="form__row">
          <label>Nostr reference</label>
          <input type="text" class="input mypage-block-embed__input" data-block-id="${block.id}" data-field="nostrRef" value="${escapeHtmlAttr(block.nostrRef)}" placeholder="nostr:nevent1… or naddr1…" />
        </div>
        <p class="mypage-block-embed__hint">
          Paste a Nostr event reference. Closes the editor to see it rendered with full ISL.
        </p>
      </div>
    `;
    return wrapEditable(block.id, 'embed', inner);
  }

  if (!block.nostrRef?.trim()) return '';

  return `<div class="mypage-block-embed" data-embed-mount data-block-id="${block.id}" data-nostr-ref="${escapeHtmlAttr(block.nostrRef)}">
    <div class="mypage-block-embed__loading pulsate">Loading note…</div>
  </div>`;
}
