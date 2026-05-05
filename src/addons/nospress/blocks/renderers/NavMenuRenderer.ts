/**
 * Nav-menu renderer — emits `<nav><ul><li><a>` markup for one of the user's
 * site menus.
 *
 * The renderer itself is shape-only: it emits a `.nospress-nav-menu-mount`
 * slot with the picked `menuId` as a data-attribute. The actual list is
 * filled in by `mountNospressNavMenus()` because rendering needs:
 *   - the menu set (with the items + their order)
 *   - the page index (to resolve page-slug → page-title)
 *   - the owner handle (to compose `/{handle}/{slug}/` URLs)
 *   - the currently-shown slug (so the matching `<li>` gets `class="active"`)
 *
 * Editable mode adds a `<select>` for picking which menu the block renders.
 */

import { wrapEditable } from './blockEditWrapper';
import { escapeHtml, escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import type { Block } from '../types';

export function renderNavMenu(block: Extract<Block, { type: 'nav-menu' }>, editable: boolean): string {
  if (editable) {
    // The `<select>` options are filled by NospressView's mount step
    // because the renderer doesn't have menu-set context. Until then,
    // show the currently-picked menu id as a single placeholder option.
    const inner = `
      <div class="nospress-block-nav-menu__pick">
        <label>Menu:</label>
        <select class="input nospress-block-nav-menu__select" data-block-id="${block.id}" data-field="menu-id">
          <option value="${escapeHtmlAttr(block.menuId)}">${escapeHtml(block.menuId)}</option>
        </select>
      </div>
      <div
        class="nospress-nav-menu-mount"
        data-menu-id="${escapeHtmlAttr(block.menuId)}"
        data-mode="editable"
      ></div>
    `;
    return wrapEditable(block.id, 'nav-menu', inner);
  }

  // Read-only: just the mount slot. PublicNospressPage's mount step fills it.
  return `<div class="nospress-nav-menu-mount" data-menu-id="${escapeHtmlAttr(block.menuId)}"></div>`;
}
