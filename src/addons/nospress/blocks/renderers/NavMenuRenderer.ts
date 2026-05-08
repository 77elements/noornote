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
import { styleWrap } from '../styles';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import type { Block } from '../types';

export function renderNavMenu(block: Extract<Block, { type: 'nav-menu' }>, editable: boolean): string {
  // `data-horizontal` is read by `mountNospressNavMenus` to apply a
  // modifier class on the rendered `<nav>` — flips the `<ul>` from the
  // default vertical stack into a side-by-side row without bullets.
  const horizontalAttr = block.horizontal ? ' data-horizontal="true"' : '';

  if (editable) {
    // CustomDropdown slot — NospressView.mountBlockDropdowns reads the
    // menu list from NospressMenuService and populates options. App-wide
    // rule: never raw `<select>` (see /scss skill).
    const inner = `
      <div class="nospress-block-nav-menu__pick">
        <div class="nospress-block-nav-menu__select-slot"
             data-block-dropdown="nav-menu-id"
             data-block-id="${block.id}"
             data-current-value="${escapeHtmlAttr(block.menuId)}"></div>
      </div>
      <div
        class="nospress-nav-menu-mount"
        data-menu-id="${escapeHtmlAttr(block.menuId)}"
        data-mode="editable"${horizontalAttr}
      ></div>
    `;
    return wrapEditable(block.id, 'nav-menu', inner);
  }

  // Read-only: mount slot — self-wrapped so styles land directly on it.
  return styleWrap(
    block,
    '',
    {
      tag: 'div',
      baseClass: 'nospress-nav-menu-mount',
      extraAttrs: `data-menu-id="${escapeHtmlAttr(block.menuId)}"${horizontalAttr}`,
    },
  );
}
