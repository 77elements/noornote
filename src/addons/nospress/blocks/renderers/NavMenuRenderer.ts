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
import type { CommonStyle } from '../styles';

/** Pick the nested `mobileMenu` slice off a CommonStyle. Returns the
 *  raw nested object — the mounter walks it section-by-section to emit
 *  per-selector CSS overrides. Empty/missing slot → empty object so the
 *  caller can short-circuit emitting the data-attr. */
function pickMobileStyle(style: CommonStyle | undefined): Record<string, unknown> {
  const sub = style?.mobileMenu;
  if (!sub) return {};
  // Filter out any sections that came back empty (e.g. fully pruned
  // after the user cleared every input in that section).
  const out: Record<string, unknown> = {};
  for (const [section, val] of Object.entries(sub)) {
    if (val && typeof val === 'object' && Object.keys(val).length > 0) {
      out[section] = val;
    }
  }
  return out;
}

function pickMobileBpStyles(
  bps: Record<string, CommonStyle> | undefined,
): Record<string, Record<string, unknown>> {
  if (!bps) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, style] of Object.entries(bps)) {
    const slice = pickMobileStyle(style);
    if (Object.keys(slice).length > 0) out[name] = slice;
  }
  return out;
}

export function renderNavMenu(block: Extract<Block, { type: 'nav-menu' }>, editable: boolean): string {
  // The mount slot exposes the layout knobs as data-attributes. The
  // mounter reads them and applies modifier classes / generates the
  // per-block CSS for hamburger visibility.
  const horizontalAttr = block.horizontal ? ' data-horizontal="true"' : '';
  const alignmentAttr = (block.alignment === 'right' || block.alignment === 'center')
    ? ` data-alignment="${block.alignment}"`
    : '';
  const bps = block.hamburgerBreakpoints ?? [];
  const hamburgerAttr = bps.length > 0
    ? ` data-hamburger-bps="${escapeHtmlAttr(bps.join(','))}"`
    : '';
  // Mobile sub-scope payload — only emit attrs when something is set.
  // Mounter parses these and emits per-block override CSS inside the
  // hamburger media-queries.
  const mobileDefault = pickMobileStyle(block.style);
  const mobileBp = pickMobileBpStyles(block.breakpointStyles);
  const mobileDefaultAttr = Object.keys(mobileDefault).length > 0
    ? ` data-mobile-style="${escapeHtmlAttr(JSON.stringify(mobileDefault))}"`
    : '';
  const mobileBpAttr = Object.keys(mobileBp).length > 0
    ? ` data-mobile-bp-styles="${escapeHtmlAttr(JSON.stringify(mobileBp))}"`
    : '';
  const mountAttrs = `data-menu-id="${escapeHtmlAttr(block.menuId)}"${horizontalAttr}${alignmentAttr}${hamburgerAttr}${mobileDefaultAttr}${mobileBpAttr}`;

  if (editable) {
    // CustomDropdown slot — NospressView.mountBlockDropdowns reads the
    // menu list from NospressMenuService and populates options. App-wide
    // rule: never raw `<select>` (see /scss skill).
    //
    // The mobile-sub-scope trigger sits next to the picker. It only
    // renders when at least one breakpoint is configured to show the
    // hamburger — without that, there's no mobile drawer to style.
    // Click is dispatched in NospressView via `data-mobile-subscope-toggle`.
    const hasHamburger = (block.hamburgerBreakpoints ?? []).length > 0;
    const triggerHtml = hasHamburger
      ? `<button type="button"
                class="nospress-block-nav-menu__mobile-trigger"
                data-mobile-subscope-toggle
                data-block-id="${block.id}"
                aria-label="Mobile menu properties">
           <svg width="16" height="16" aria-hidden="true"><use href="#icon-menu-bars"/></svg>
         </button>`
      : '';
    const inner = `
      <div class="nospress-block-nav-menu__pick">
        <div class="nospress-block-nav-menu__select-slot"
             data-block-dropdown="nav-menu-id"
             data-block-id="${block.id}"
             data-current-value="${escapeHtmlAttr(block.menuId)}"></div>
        ${triggerHtml}
      </div>
      <div
        class="nospress-nav-menu-mount"
        data-mode="editable"
        ${mountAttrs}
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
      extraAttrs: mountAttrs,
    },
  );
}
