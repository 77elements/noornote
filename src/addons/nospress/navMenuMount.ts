/**
 * Mount step for nav-menu blocks. Walks the container for
 * `.nospress-nav-menu-mount` slots and fills each with a real
 * `<nav><ul><li><a>` tree. The `<li>` whose page-slug matches the
 * currently-shown slug gets `class="active"` so users can style the
 * current item via custom CSS.
 *
 * Per-block knobs (read from data-attributes on the slot):
 *   - data-horizontal       — flat row instead of vertical stack
 *   - data-alignment="right" — push items / button to the right
 *   - data-hamburger-bps    — comma-list of breakpoint names (or `''` for
 *                             Default = always) at which the menu collapses
 *                             behind a hamburger button. Per-BP CSS is
 *                             injected as an inline `<style>` next to the
 *                             slot; the click handler toggles `is-open`
 *                             on the `<ul>`.
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
import type { NospressBreakpoint } from './blocks/siteSettings';

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
  /** Site-wide breakpoint definitions, used to translate hamburger-BP
   *  names into media queries. Optional; without it, hamburger only
   *  works for the Default ('') entry. */
  breakpoints?: NospressBreakpoint[];
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

    const horizontal = slot.dataset.horizontal === 'true';
    const alignment = slot.dataset.alignment; // 'right' | 'center' | undefined
    const hamburgerBps = (slot.dataset.hamburgerBps ?? '').split(',').filter(s => s.length > 0 || s === '');
    // Empty string in the array means Default (always-on). Filter() above
    // drops empty strings, so re-add it explicitly when the raw includes it.
    const rawHamburger = slot.dataset.hamburgerBps;
    if (rawHamburger !== undefined && rawHamburger.split(',').some(s => s === '')) {
      if (!hamburgerBps.includes('')) hamburgerBps.push('');
    }

    const navClasses: string[] = [];
    if (horizontal) navClasses.push('nospress-nav-menu--horizontal');
    if (alignment === 'right') navClasses.push('nospress-nav-menu--align-right');
    else if (alignment === 'center') navClasses.push('nospress-nav-menu--align-center');
    const navClassAttr = navClasses.length ? ` class="${navClasses.join(' ')}"` : '';

    // Hamburger: button always rendered, default-hidden via SCSS. The
    // per-block <style> below toggles its visibility based on the
    // user-picked breakpoints.
    slot.innerHTML = `
      <nav${navClassAttr}>
        <button type="button" class="nospress-nav-menu__hamburger" aria-label="Toggle menu" aria-expanded="false">
          <svg width="22" height="22" aria-hidden="true"><use href="#icon-hamburger"/></svg>
        </button>
        <ul class="nospress-nav-menu__list">${items}</ul>
      </nav>
    `;

    // Click handler: toggle `is-open` on the list. Body-level click-away
    // closes the menu so it doesn't linger when the user reads on.
    const navEl = slot.querySelector<HTMLElement>('nav');
    const button = slot.querySelector<HTMLButtonElement>('.nospress-nav-menu__hamburger');
    const list = slot.querySelector<HTMLElement>('.nospress-nav-menu__list');
    if (navEl && button && list) {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = list.classList.toggle('is-open');
        button.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }

    // Inject per-block hamburger CSS into a `<style>` right next to the
    // slot. Each block gets its own scope via the slot's
    // `data-styled-block-id` attribute (set by styleWrap upstream).
    const blockId = slot.dataset.styledBlockId;
    if (blockId && hamburgerBps.length > 0) {
      const styleEl = document.createElement('style');
      styleEl.textContent = buildHamburgerCss(blockId, hamburgerBps, ctx.breakpoints ?? []);
      slot.appendChild(styleEl);
    }
  });
}

/** Build the @media-wrapped CSS rules that flip the menu into hamburger
 *  mode at the user-picked breakpoints. Empty-string entry means Default
 *  (no media query — always hamburger). Unknown BP names are skipped. */
function buildHamburgerCss(blockId: string, bpNames: string[], breakpoints: NospressBreakpoint[]): string {
  const sel = `[data-styled-block-id="${blockId}"]`;
  const innerRules = `
    ${sel} .nospress-nav-menu__hamburger { display: block; }
    ${sel} .nospress-nav-menu__list:not(.is-open) { display: none; }
  `;
  const out: string[] = [];
  for (const name of bpNames) {
    if (name === '') {
      out.push(innerRules);
      continue;
    }
    const bp = breakpoints.find(b => b.name === name);
    if (!bp) continue;
    const mq = mediaQueryFor(bp);
    if (mq) out.push(`@media ${mq} { ${innerRules} }`);
  }
  return out.join('\n');
}

function mediaQueryFor(bp: NospressBreakpoint): string | null {
  const v1 = bp.value.trim();
  if (!v1) return null;
  if (bp.type === 'min') return `(min-width: ${v1})`;
  if (bp.type === 'max') return `(max-width: ${v1})`;
  if (bp.type === 'between') {
    const v2 = (bp.value2 ?? '').trim();
    if (!v2) return null;
    return `(min-width: ${v1}) and (max-width: ${v2})`;
  }
  return null;
}
