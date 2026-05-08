/**
 * BookmarkFolderRenderer
 *
 * Editable: emits a slot (`<div data-bookmark-folder-picker>`) where NospressView
 * mounts a BookmarkFolderPicker JS instance after innerHTML. The slot carries
 * the current folderName as a data attribute so NospressView knows what to
 * pre-select.
 *
 * Readonly: emits an inline mount slot (`<div class="nospress-bookmark-folder-mount">`)
 * which `mountInlineBookmarkFolders()` in NospressView fills with a
 * `ProfileListsComponent` rendering the folder's items. The slot carries the
 * folder name + block id so the mounter knows what to fetch.
 */

import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import { styleWrap } from '../styles';
import type { Block } from '../types';

export function renderBookmarkFolder(
  block: Extract<Block, { type: 'bookmark-folder' }>,
  editable = false
): string {
  if (editable) {
    const inner = `
      <div class="nospress-block-bookmark-folder">
        <label class="nospress-block-bookmark-folder__label">Mounted bookmark folder:</label>
        <div
          class="nospress-block-bookmark-folder__picker-slot"
          data-bookmark-folder-picker
          data-block-id="${block.id}"
          data-folder-name="${escapeHtmlAttr(block.folderName || '')}"
        ></div>
      </div>
    `;
    return wrapEditable(block.id, 'bookmark-folder', inner);
  }
  if (!block.folderName) return '';
  return styleWrap(
    block,
    '',
    {
      tag: 'div',
      baseClass: 'nospress-bookmark-folder-mount',
      extraAttrs: `data-folder-name="${escapeHtmlAttr(block.folderName)}" data-block-id="${block.id}"`,
    },
  );
}
