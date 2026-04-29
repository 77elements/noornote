/**
 * BookmarkFolderRenderer
 *
 * Editable: emits a slot (`<div data-bookmark-folder-picker>`) where MypageView
 * mounts a BookmarkFolderPicker JS instance after innerHTML. The slot carries
 * the current folderName as a data attribute so MypageView knows what to
 * pre-select.
 *
 * Readonly: Slice 6 returns an empty string — bookmark-folder content is
 * still rendered separately by ProfileListsComponent at the end of MypageView
 * (legacy path). Slice 7 will move readonly rendering inline so blocks
 * appear in their actual order. The slice 6 trade-off: bookmark-folder
 * blocks can be EDITED via the picker, but readonly preview shows them at
 * the end as before.
 */

import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import type { Block } from '../types';

export function renderBookmarkFolder(
  block: Extract<Block, { type: 'bookmark-folder' }>,
  editable = false
): string {
  if (editable) {
    const inner = `
      <div class="mypage-block-bookmark-folder">
        <label class="mypage-block-bookmark-folder__label">Mounted bookmark folder:</label>
        <div
          class="mypage-block-bookmark-folder__picker-slot"
          data-bookmark-folder-picker
          data-block-id="${block.id}"
          data-folder-name="${escapeHtmlAttr(block.folderName || '')}"
        ></div>
        <p class="mypage-block-bookmark-folder__hint">
          The folder content (items) renders below the page in the readonly view. Inline rendering arrives in a later slice.
        </p>
      </div>
    `;
    return wrapEditable(block.id, 'bookmark-folder', inner);
  }
  // Readonly: empty — ProfileListsComponent at the end handles the actual
  // rendering for now. Slice 7 will move this inline.
  return '';
}
