/**
 * Mount step for nav-menu blocks. Walks the container for
 * `.nospress-nav-menu-mount` slots and fills each with a real
 * `<nav><ul><li><a>` tree. The `<li>` whose page-slug matches the
 * currently-shown slug gets `class="active"` so users can style the
 * current item via custom CSS.
 *
 * Used by:
 *   - NospressView (editor preview, ctx.editorPreview=true so links don't
 *     navigate when clicked)
 *   - PublicNospressPage (live render, ctx.editorPreview=false)
 */

import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { sanitizeUrl } from '../../helpers/sanitizeUrl';
import { HOME_SLUG } from './blocks/pageIndex';
import { PRIMARY_MENU_ID, type NospressMenuSet } from './blocks/menu';
import type { NospressPageIndex } from './blocks/pageIndex';

export interface NavMenuMountCtx {
  menuSet: NospressMenuSet;
  pageIndex: NospressPageIndex;
  /** Owner handle (nip05 or npub) used to compose `/{handle}/{slug}/` URLs. */
  ownerHandle: string;
  /** Slug of the page currently being shown. The matching <li> gets
   *  `class="active"`. Empty string = home. */
  currentSlug: string;
  /** True in the editor preview — anchors render as `href="#"` so clicks
   *  don't yank the user out of the editor. Default: false. */
  editorPreview?: boolean;
}

export function mountNospressNavMenus(container: HTMLElement, ctx: NavMenuMountCtx): void {
  const slots = container.querySelectorAll<HTMLElement>('.nospress-nav-menu-mount');
  slots.forEach(slot => {
    const menuId = slot.dataset.menuId ?? PRIMARY_MENU_ID;
    const menu = ctx.menuSet.menus.find(m => m.id === menuId);
    if (!menu) {
      slot.innerHTML = '';
      return;
    }

    const items = menu.items.map(item => {
      if (item.type === 'page') {
        const entry = ctx.pageIndex.pages.find(p => p.slug === item.pageSlug);
        if (!entry) return '';
        const slugPath = item.pageSlug === HOME_SLUG ? '' : `${encodeURIComponent(item.pageSlug)}/`;
        const href = ctx.editorPreview ? '#' : `/${ctx.ownerHandle}/${slugPath}`;
        const isActive = item.pageSlug === ctx.currentSlug;
        const liClass = isActive ? ' class="active"' : '';
        return `<li${liClass}><a href="${escapeHtmlAttr(href)}">${escapeHtml(entry.title)}</a></li>`;
      }
      // External URL item — never gets the active class (it's outside the site).
      const safeUrl = sanitizeUrl(item.url);
      if (!ctx.editorPreview && !safeUrl) return '';
      const href = ctx.editorPreview ? '#' : safeUrl;
      return `<li><a href="${escapeHtmlAttr(href)}" rel="noopener noreferrer" target="_blank">${escapeHtml(item.label)}</a></li>`;
    }).filter(s => s.length > 0).join('');

    // Slot's `data-horizontal="true"` flips the layout to a side-by-side
    // row without bullets — toggled from the Properties panel's "Horizontal"
    // checkbox. Default (no attribute) is the standard vertical stack.
    const horizontalClass = slot.dataset.horizontal === 'true' ? ' class="nospress-nav-menu--horizontal"' : '';
    slot.innerHTML = `<nav${horizontalClass}><ul>${items}</ul></nav>`;
  });
}
