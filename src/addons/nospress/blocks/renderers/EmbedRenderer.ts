import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import { styleWrap } from '../styles';
import type { Block } from '../types';

/**
 * EmbedRenderer
 *
 * Editable: a single input for the nostr reference (`nostr:nevent1…` /
 * `nevent1…` / `note1…` / `naddr1…`). The NospressView event delegation
 * persists changes silently (debounced) — no live preview during typing.
 *
 * Readonly: emits a placeholder div with `data-embed-mount` carrying the
 * block id + raw nostrRef. NospressView walks these slots after innerHTML,
 * decodes/fetches the event, and mounts a NoteUI element in place — same
 * pipeline that powers timeline notes, so ISL + reactions work for free.
 *
 * Empty refs render nothing in readonly mode.
 */
export function renderEmbed(block: Extract<Block, { type: 'embed' }>, editable = false): string {
  if (editable) {
    const inner = `
      <div class="nospress-block-embed__edit">
        <div class="form__row">
          <label>Nostr reference</label>
          <input type="text" class="input nospress-block-embed__input" data-block-id="${block.id}" data-field="nostrRef" value="${escapeHtmlAttr(block.nostrRef)}" placeholder="nostr:nevent1… or naddr1…" />
        </div>
        <p class="nospress-block-embed__hint">
          Paste a Nostr event reference. Closes the editor to see it rendered with full ISL.
        </p>
      </div>
    `;
    return wrapEditable(block.id, 'embed', inner);
  }

  if (!block.nostrRef?.trim()) return '';

  return styleWrap(
    block,
    `<div class="nospress-block-embed__loading pulsate">Loading note…</div>`,
    {
      tag: 'div',
      baseClass: 'nospress-block-embed',
      extraAttrs: `data-embed-mount data-block-id="${block.id}" data-nostr-ref="${escapeHtmlAttr(block.nostrRef)}"`,
    },
  );
}
