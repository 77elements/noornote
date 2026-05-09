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

/** Marker attribute we set on portaled drawer + overlay elements so a
 *  re-mount can find and clean up the previous render's leftovers. */
const PORTAL_ATTR = 'data-nospress-nav-portal';

/** Remove every drawer + overlay this module has portaled to <body>.
 *  Call on view destroy so navigating away doesn't leak fixed-position
 *  panels into the next view. */
export function unmountNospressNavMenus(): void {
  document.querySelectorAll(`[${PORTAL_ATTR}]`).forEach(el => el.remove());
}

export function mountNospressNavMenus(container: HTMLElement, ctx: NavMenuMountCtx): void {
  // Wipe any leftovers from a previous render of the same view — the
  // portaled drawer/overlay elements live on <body>, so a fresh
  // container.innerHTML didn't take them out.
  unmountNospressNavMenus();

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
    // Missing attribute = no hamburger configured. Empty-string entry in the
    // attribute means Default (always-on, no media-query wrapping).
    const rawHamburger = slot.dataset.hamburgerBps;
    const hamburgerBps = rawHamburger === undefined ? [] : rawHamburger.split(',');

    const navClasses: string[] = [];
    if (horizontal) navClasses.push('nospress-nav-menu--horizontal');
    if (alignment === 'right') navClasses.push('nospress-nav-menu--align-right');
    else if (alignment === 'center') navClasses.push('nospress-nav-menu--align-center');
    const navClassAttr = navClasses.length ? ` class="${navClasses.join(' ')}"` : '';

    // Hamburger: button always rendered, default-hidden via SCSS. The
    // per-block <style> below toggles its visibility based on the
    // user-picked breakpoints. The overlay sits as a sibling to <nav> so
    // a fixed-position drawer + click-away backdrop works without DOM
    // re-parenting.
    slot.innerHTML = `
      <nav${navClassAttr}>
        <button type="button" class="nospress-nav-menu__hamburger" aria-label="Toggle menu" aria-expanded="false">
          <svg width="22" height="22" aria-hidden="true"><use href="#icon-hamburger"/></svg>
        </button>
        <ul class="nospress-nav-menu__list">${items}</ul>
      </nav>
      <div class="nospress-nav-menu__overlay" aria-hidden="true"></div>
    `;

    // Click handler: toggle `is-open` on the list + `is-visible` on the
    // overlay. Overlay click and any anchor click inside the drawer close
    // the menu so it doesn't linger.
    const navEl = slot.querySelector<HTMLElement>('nav');
    const button = slot.querySelector<HTMLButtonElement>('.nospress-nav-menu__hamburger');
    const list = slot.querySelector<HTMLElement>('.nospress-nav-menu__list');
    const overlay = slot.querySelector<HTMLElement>('.nospress-nav-menu__overlay');
    if (navEl && button && list && overlay) {
      const close = () => {
        list.classList.remove('is-open');
        overlay.classList.remove('is-visible');
        button.setAttribute('aria-expanded', 'false');
      };
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = list.classList.toggle('is-open');
        overlay.classList.toggle('is-visible', open);
        button.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      overlay.addEventListener('click', close);
      list.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('a')) close();
      });
    }

    // Inject per-block hamburger CSS into a `<style>` right next to the
    // slot. Each block gets its own scope via the slot's
    // `data-styled-block-id` attribute (set by styleWrap upstream). The
    // alignment dictates whether the menu becomes a left/right slide-in
    // drawer or stays a center dropdown (current behaviour).
    const blockId = slot.dataset.styledBlockId;
    if (blockId && hamburgerBps.length > 0) {
      const drawerSide: 'left' | 'right' | null =
        alignment === 'right' ? 'right' :
        alignment === 'center' ? null : 'left';

      // Drawer mode: portal the list + overlay to <body> so an ancestor
      // `clip-path` (e.g. a divider on the wrapping div block) doesn't
      // visually clip the fixed-position drawer. Tag both elements with
      // their own `data-styled-block-id` + portal marker so the per-block
      // CSS selector can match them directly outside the wrapper tree.
      if (drawerSide && list && overlay) {
        list.setAttribute('data-styled-block-id', blockId);
        list.setAttribute(PORTAL_ATTR, blockId);
        overlay.setAttribute('data-styled-block-id', blockId);
        overlay.setAttribute(PORTAL_ATTR, blockId);
        document.body.appendChild(list);
        document.body.appendChild(overlay);
      }

      const mobileStyle = parseStyleAttr(slot.dataset.mobileStyle);
      const mobileBpStyles = parseBpStylesAttr(slot.dataset.mobileBpStyles);

      const styleEl = document.createElement('style');
      styleEl.textContent = buildHamburgerCss(
        blockId, hamburgerBps, ctx.breakpoints ?? [], drawerSide,
        mobileStyle, mobileBpStyles,
      );
      slot.appendChild(styleEl);
    }
  });
}

/** Mobile sub-scope keys → CSS targeting inside the per-block scope.
 *  Each entry produces one declaration per active BP, applied with
 *  `!important` so it outranks the drawer base rules emitted alongside.
 *  Selector takes the wrapper attribute selector (e.g.
 *  `[data-styled-block-id="X"]`) and returns the full target selector. */
const MOBILE_STYLE_TARGETS: Record<
  string,
  { selector: (sel: string) => string; cssProp: string }
> = {
  mobileBackground:  { selector: (sel) => `.nospress-nav-menu__list${sel}`,           cssProp: 'background' },
  mobileColor:       { selector: (sel) => `.nospress-nav-menu__list${sel} li a`,      cssProp: 'color' },
  mobileActiveColor: { selector: (sel) => `.nospress-nav-menu__list${sel} li.active a`, cssProp: 'color' },
  mobileFontSize:    { selector: (sel) => `.nospress-nav-menu__list${sel} li a`,      cssProp: 'font-size' },
  hamburgerColor:    { selector: (sel) => `${sel} .nospress-nav-menu__hamburger`,     cssProp: 'color' },
  overlayBackground: { selector: (sel) => `.nospress-nav-menu__overlay${sel}`,        cssProp: 'background' },
};

/** Strip characters that could break out of `style="…"` mirror — same
 *  ruleset as `sanitizeStyleValue` in styles.ts but tolerant of the
 *  characters we actually need (colons for var(), commas for rgba). */
function sanitizeMobileValue(raw: string): string {
  const stripped = raw.replace(/[;<>"'\\]/g, '').trim().slice(0, 1000);
  if (/url\s*\(\s*['"]?\s*(javascript|data|vbscript)\s*:/i.test(stripped)) return '';
  return stripped;
}

/** Compose the override declarations from a mobile-style slice. */
function buildMobileOverrides(sel: string, style: Record<string, string>): string {
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(style)) {
    const target = MOBILE_STYLE_TARGETS[key];
    if (!target) continue;
    const v = sanitizeMobileValue(raw);
    if (!v) continue;
    parts.push(`${target.selector(sel)} { ${target.cssProp}: ${v} !important; }`);
  }
  return parts.join('\n');
}

function parseStyleAttr(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

function parseBpStylesAttr(raw: string | undefined): Record<string, Record<string, string>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, Record<string, string>> : {};
  } catch { return {}; }
}

/** Build the @media-wrapped CSS rules that flip the menu into hamburger
 *  mode at the user-picked breakpoints. Empty-string entry means Default
 *  (no media query — always hamburger). Unknown BP names are skipped.
 *
 *  `drawerSide` picks the hamburger flavour:
 *    - `'left'` / `'right'`: slide-in drawer from that side, with backdrop
 *    - `null` (alignment=center): collapsed dropdown, items stay in flow
 *
 *  `mobileStyle` (Default tab values) gets folded into every BP's rule
 *  block. `mobileBpStyles[bpName]` (per-BP overrides) only gets folded
 *  into that one BP's @media. Per-BP overrides win because they're
 *  emitted last with `!important` (same as the rest of the per-BP
 *  override pipeline in `buildBlockBreakpointCss`).
 */
function buildHamburgerCss(
  blockId: string,
  bpNames: string[],
  breakpoints: NospressBreakpoint[],
  drawerSide: 'left' | 'right' | null,
  mobileStyle: Record<string, string> = {},
  mobileBpStyles: Record<string, Record<string, string>> = {},
): string {
  const sel = `[data-styled-block-id="${blockId}"]`;
  const drawerRules = drawerSide
    ? buildDrawerRules(sel, drawerSide)
    : buildCenterDropdownRules(sel);
  const defaultOverrides = buildMobileOverrides(sel, mobileStyle);
  const out: string[] = [];
  for (const name of bpNames) {
    const bpOverrides = buildMobileOverrides(sel, mobileBpStyles[name] ?? {});
    const bundle = `${drawerRules}\n${defaultOverrides}\n${bpOverrides}`;
    if (name === '') {
      out.push(bundle);
      continue;
    }
    const bp = breakpoints.find(b => b.name === name);
    if (!bp) continue;
    const mq = mediaQueryFor(bp);
    if (mq) out.push(`@media ${mq} { ${bundle} }`);
  }
  return out.join('\n');
}

/** Slide-in drawer: list becomes a fixed off-screen panel that slides on
 *  `is-open`. Resets list-item layout to a vertical stack regardless of
 *  the block's `--horizontal` / `--align-*` modifiers (they only make
 *  sense for the inline desktop rendering).
 *
 *  Drawer + overlay are portaled out of the wrapper tree to escape any
 *  ancestor `clip-path`, so they're addressed directly via their own
 *  `data-styled-block-id` attribute (set on each portaled element by the
 *  mounter), not as descendants of the slot's wrapper. */
function buildDrawerRules(sel: string, side: 'left' | 'right'): string {
  const offscreen = side === 'left' ? 'translateX(-100%)' : 'translateX(100%)';
  const sideRule = side === 'left' ? 'left: 0;' : 'right: 0;';
  return `
    ${sel} .nospress-nav-menu__hamburger { display: block; }
    .nospress-nav-menu__overlay${sel} { display: block; }
    .nospress-nav-menu__list${sel} {
      position: fixed;
      top: 0;
      bottom: 0;
      ${sideRule}
      width: 250px;
      max-width: 80vw;
      z-index: 200;
      display: block;
      grid-auto-flow: initial;
      grid-auto-columns: initial;
      list-style: none;
      margin: 0;
      padding: 1rem;
      text-align: left;
      background: var(--color-1);
      overflow-y: auto;
      transform: ${offscreen};
      transition: transform 0.3s ease;
    }
    .nospress-nav-menu__list${sel}.is-open { transform: translateX(0); }
    .nospress-nav-menu__list${sel} li { display: block; text-align: left; }
  `;
}

/** Center alignment: keep the original behaviour — list collapses in
 *  place, expands on `is-open` without leaving the document flow. */
function buildCenterDropdownRules(sel: string): string {
  return `
    ${sel} .nospress-nav-menu__hamburger { display: block; }
    ${sel} .nospress-nav-menu__list:not(.is-open) { display: none; }
  `;
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
