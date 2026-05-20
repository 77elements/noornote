/**
 * Dotted-path getter + setter for `CommonStyle` payloads. The Properties
 * panel writes via `data-style-field="<path>"` attributes — those paths
 * land here.
 *
 * Path forms:
 *   - `color`                                — flat single
 *   - `margin.top`                           — quad sub-field
 *   - `divider.top` / `divider.flipX`        — divider struct sub-field
 *   - `textShadow.h` / `textShadow.color`    — text-shadow sub-field
 *   - `mobileMenu.<sec>.<rest>`              — recursive sub-scope
 *   - `links.<pseudo>.<rest>`                — recursive sub-scope
 *   - `navMenu.<key>.<rest>`                 — recursive sub-scope
 *   - `bookmarkFolder.<key>.<rest>`          — recursive sub-scope
 *   - `articlesList.<key>.<rest>`            — recursive sub-scope
 *   - `portfolio.<key>.<rest>`               — recursive sub-scope
 *   - `weblog.<key>.<rest>`                  — recursive sub-scope
 */

import { migrateLegacyBorder } from './build';
import { PROPERTY_CATALOG } from './catalog';
import type {
  ArticlesListKey,
  BookmarkFolderKey,
  CommonStyle,
  DividerStyle,
  LinkPseudo,
  MobileMenuSection,
  NavMenuDesktopKey,
  PortfolioKey,
  PropertyKey,
  QuadSide,
  WeblogKey,
} from './types';

/** Read a dotted path: `color`, `margin.top`, or `divider.top`. */
export function readStyleField(styleIn: CommonStyle | undefined, path: string): string | undefined {
  if (!styleIn) return undefined;
  // Mobile-menu sub-scope: `mobileMenu.<section>.<rest>` → recurse into
  // the per-selector sub-style. The rest can be 1- or 2-segment (e.g.
  // 'background' or 'margin.top'), so we re-enter readStyleField with
  // the remainder.
  if (path.startsWith('mobileMenu.')) {
    const [, section, ...rest] = path.split('.');
    const sub = styleIn.mobileMenu?.[section as MobileMenuSection];
    return readStyleField(sub, rest.join('.'));
  }
  // Link sub-scope: `links.<pseudo>.<rest>` → recurse into the per-pseudo
  // sub-style. Same recursive trick as mobileMenu.
  if (path.startsWith('links.')) {
    const [, pseudo, ...rest] = path.split('.');
    const sub = styleIn.links?.[pseudo as LinkPseudo];
    return readStyleField(sub, rest.join('.'));
  }
  // Nav-menu desktop sub-scope: `navMenu.<ul|li>.<rest>` → recurse.
  if (path.startsWith('navMenu.')) {
    const [, key, ...rest] = path.split('.');
    const sub = styleIn.navMenu?.[key as NavMenuDesktopKey];
    return readStyleField(sub, rest.join('.'));
  }
  // Bookmark-folder sub-scope: `bookmarkFolder.<item|icon|desc>.<rest>` → recurse.
  if (path.startsWith('bookmarkFolder.')) {
    const [, key, ...rest] = path.split('.');
    const sub = styleIn.bookmarkFolder?.[key as BookmarkFolderKey];
    return readStyleField(sub, rest.join('.'));
  }
  // Articles-list sub-scope: `articlesList.<card|title|meta>.<rest>` → recurse.
  if (path.startsWith('articlesList.')) {
    const [, key, ...rest] = path.split('.');
    const sub = styleIn.articlesList?.[key as ArticlesListKey];
    return readStyleField(sub, rest.join('.'));
  }
  // Portfolio sub-scope: `portfolio.<closeBtn|closeBtnHover>.<rest>` → recurse.
  if (path.startsWith('portfolio.')) {
    const [, key, ...rest] = path.split('.');
    const sub = styleIn.portfolio?.[key as PortfolioKey];
    return readStyleField(sub, rest.join('.'));
  }
  // Weblog sub-scope: `weblog.<note|noteHover|isl>.<rest>` → recurse.
  if (path.startsWith('weblog.')) {
    const [, key, ...rest] = path.split('.');
    const sub = styleIn.weblog?.[key as WeblogKey];
    return readStyleField(sub, rest.join('.'));
  }
  // Card-hover sub-scope: `cardHover.<rest>` → recurse into the flat
  // sub-style. One hop shorter than the other sub-scopes — hover is the
  // only state we surface for now, so no per-element key layer.
  if (path.startsWith('cardHover.')) {
    const [, ...rest] = path.split('.');
    return readStyleField(styleIn.cardHover, rest.join('.'));
  }
  // Sticky sub-scope: `sticky.<rest>` → same flat single-state shape as
  // cardHover. Surfaced when `position: sticky` and toggled by the
  // IntersectionObserver-driven `.is-stuck` class at runtime.
  if (path.startsWith('sticky.')) {
    const [, ...rest] = path.split('.');
    return readStyleField(styleIn.sticky, rest.join('.'));
  }
  // Hydrate the new border fields from the legacy shorthand if the user
  // hasn't touched them yet. Returned values pre-fill the property panel
  // inputs so old data is visible + editable; the next write clears the
  // legacy `border` field via `writeStyleField`.
  const style = migrateLegacyBorder(styleIn);
  const segments = path.split('.');
  if (segments.length === 1) {
    const v = style[segments[0] as PropertyKey];
    return typeof v === 'string' ? v : undefined;
  }
  if (segments.length === 2) {
    const [head, side] = segments as [PropertyKey, string];
    const group = style[head];
    if (!group || typeof group === 'string') return undefined;
    const v = (group as Record<string, unknown>)[side];
    if (typeof v === 'string') return v;
    // Boolean flags inside groups (e.g. `divider.flipX`) — surface as
    // '1'/'' so the checkbox-rendering UI gets a non-empty truthy
    // marker without us inventing a separate boolean read API.
    if (typeof v === 'boolean') return v ? '1' : '';
    // Tolerate the legacy divider shape `{ style?, color?, height? }`
    // — expose its `.style` field so events stored before the shape
    // change still pre-fill the picker correctly.
    if (head === 'divider' && v && typeof v === 'object'
        && typeof (v as { style?: unknown }).style === 'string') {
      return (v as { style: string }).style;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Write a dotted path. Empty / whitespace value deletes the field.
 * Mutates `style` in place. Caller is responsible for ensuring `style`
 * is an object (not undefined) — typically by initialising at the
 * mutation site.
 */
export function writeStyleField(style: CommonStyle, path: string, rawValue: string): void {
  const trimmed = rawValue.trim();
  // Mobile-menu sub-scope: `mobileMenu.<section>.<rest>` → ensure the
  // section sub-style exists, recurse into it. Prune empty sections +
  // the parent `mobileMenu` so `hasV2Content` stays accurate.
  if (path.startsWith('mobileMenu.')) {
    const [, section, ...rest] = path.split('.');
    const sec = section as MobileMenuSection;
    if (!style.mobileMenu) style.mobileMenu = {};
    if (!style.mobileMenu[sec]) style.mobileMenu[sec] = {};
    writeStyleField(style.mobileMenu[sec]!, rest.join('.'), rawValue);
    if (Object.keys(style.mobileMenu[sec]!).length === 0) delete style.mobileMenu[sec];
    if (Object.keys(style.mobileMenu).length === 0) delete style.mobileMenu;
    return;
  }
  // Link sub-scope: `links.<pseudo>.<rest>` → ensure the per-pseudo sub
  // exists, recurse into it, prune empty sub + parent.
  if (path.startsWith('links.')) {
    const [, pseudo, ...rest] = path.split('.');
    const ps = pseudo as LinkPseudo;
    if (!style.links) style.links = {};
    if (!style.links[ps]) style.links[ps] = {};
    writeStyleField(style.links[ps]!, rest.join('.'), rawValue);
    if (Object.keys(style.links[ps]!).length === 0) delete style.links[ps];
    if (Object.keys(style.links).length === 0) delete style.links;
    return;
  }
  // Nav-menu desktop sub-scope: `navMenu.<ul|li>.<rest>` → recurse, prune.
  if (path.startsWith('navMenu.')) {
    const [, key, ...rest] = path.split('.');
    const k = key as NavMenuDesktopKey;
    if (!style.navMenu) style.navMenu = {};
    if (!style.navMenu[k]) style.navMenu[k] = {};
    writeStyleField(style.navMenu[k]!, rest.join('.'), rawValue);
    if (Object.keys(style.navMenu[k]!).length === 0) delete style.navMenu[k];
    if (Object.keys(style.navMenu).length === 0) delete style.navMenu;
    return;
  }
  // Bookmark-folder sub-scope: `bookmarkFolder.<item|icon|desc>.<rest>` → recurse, prune.
  if (path.startsWith('bookmarkFolder.')) {
    const [, key, ...rest] = path.split('.');
    const k = key as BookmarkFolderKey;
    if (!style.bookmarkFolder) style.bookmarkFolder = {};
    if (!style.bookmarkFolder[k]) style.bookmarkFolder[k] = {};
    writeStyleField(style.bookmarkFolder[k]!, rest.join('.'), rawValue);
    if (Object.keys(style.bookmarkFolder[k]!).length === 0) delete style.bookmarkFolder[k];
    if (Object.keys(style.bookmarkFolder).length === 0) delete style.bookmarkFolder;
    return;
  }
  // Articles-list sub-scope: `articlesList.<card|title|meta>.<rest>` → recurse, prune.
  if (path.startsWith('articlesList.')) {
    const [, key, ...rest] = path.split('.');
    const k = key as ArticlesListKey;
    if (!style.articlesList) style.articlesList = {};
    if (!style.articlesList[k]) style.articlesList[k] = {};
    writeStyleField(style.articlesList[k]!, rest.join('.'), rawValue);
    if (Object.keys(style.articlesList[k]!).length === 0) delete style.articlesList[k];
    if (Object.keys(style.articlesList).length === 0) delete style.articlesList;
    return;
  }
  // Portfolio sub-scope: `portfolio.<closeBtn|closeBtnHover>.<rest>` → recurse, prune.
  if (path.startsWith('portfolio.')) {
    const [, key, ...rest] = path.split('.');
    const k = key as PortfolioKey;
    if (!style.portfolio) style.portfolio = {};
    if (!style.portfolio[k]) style.portfolio[k] = {};
    writeStyleField(style.portfolio[k]!, rest.join('.'), rawValue);
    if (Object.keys(style.portfolio[k]!).length === 0) delete style.portfolio[k];
    if (Object.keys(style.portfolio).length === 0) delete style.portfolio;
    return;
  }
  // Weblog sub-scope: `weblog.<note|noteHover|isl>.<rest>` → recurse, prune.
  if (path.startsWith('weblog.')) {
    const [, key, ...rest] = path.split('.');
    const k = key as WeblogKey;
    if (!style.weblog) style.weblog = {};
    if (!style.weblog[k]) style.weblog[k] = {};
    writeStyleField(style.weblog[k]!, rest.join('.'), rawValue);
    if (Object.keys(style.weblog[k]!).length === 0) delete style.weblog[k];
    if (Object.keys(style.weblog).length === 0) delete style.weblog;
    return;
  }
  // Card-hover sub-scope: `cardHover.<rest>` → ensure the sub exists,
  // recurse, prune empty parent so `hasV2Content` stays accurate.
  if (path.startsWith('cardHover.')) {
    const [, ...rest] = path.split('.');
    if (!style.cardHover) style.cardHover = {};
    writeStyleField(style.cardHover, rest.join('.'), rawValue);
    if (Object.keys(style.cardHover).length === 0) delete style.cardHover;
    return;
  }
  // Sticky sub-scope: `sticky.<rest>` → same flat-sub-style + prune
  // pattern as cardHover.
  if (path.startsWith('sticky.')) {
    const [, ...rest] = path.split('.');
    if (!style.sticky) style.sticky = {};
    writeStyleField(style.sticky, rest.join('.'), rawValue);
    if (Object.keys(style.sticky).length === 0) delete style.sticky;
    return;
  }
  const segments = path.split('.');
  if (segments.length === 1) {
    const head = segments[0] as PropertyKey;
    // Single-string properties go straight onto the style record.
    // Dropdown entries also write to a single string slot (the catalog
    // entry's `key` matches the CommonStyle field).
    const entry = PROPERTY_CATALOG[head];
    if (entry?.kind === 'single' || entry?.kind === 'dropdown') {
      if (trimmed) (style as Record<string, string>)[head] = trimmed;
      else delete (style as Record<string, unknown>)[head];
      // Touching any of the new border fields clears the legacy
      // shorthand so the next save persists clean data.
      if (head === 'borderStyle') delete style.border;
    }
    return;
  }
  if (segments.length === 2) {
    const head = segments[0];
    if (head === 'margin' || head === 'padding'
        || head === 'borderWidth' || head === 'borderColor'
        || head === 'positionInsets') {
      const side = segments[1] as QuadSide;
      if (side !== 'top' && side !== 'bottom' && side !== 'left' && side !== 'right') return;
      if (!style[head]) style[head] = {};
      if (trimmed) style[head]![side] = trimmed;
      else delete style[head]![side];
      // Prune empty quad slots so `hasV2Content` stays accurate.
      if (Object.keys(style[head]!).length === 0) delete style[head];
      // Touching any of the new border quads clears the legacy shorthand.
      if (head === 'borderWidth' || head === 'borderColor') delete style.border;
      return;
    }
    if (head === 'divider') {
      const sub = segments[1];
      if (sub === 'top' || sub === 'bottom') {
        if (!style.divider) style.divider = {};
        if (trimmed && trimmed !== 'none') {
          style.divider[sub] = trimmed as DividerStyle;
        } else {
          delete style.divider[sub];
        }
      } else if (sub === 'flipX' || sub === 'flipY') {
        if (!style.divider) style.divider = {};
        if (trimmed) style.divider[sub] = true;
        else delete style.divider[sub];
      } else {
        return;
      }
      // Prune empty objects so `hasV2Content` reports the slot as unused.
      if (Object.keys(style.divider).length === 0) delete style.divider;
      return;
    }
    if (head === 'textShadow') {
      const sub = segments[1] as 'h' | 'v' | 'blur' | 'color';
      if (sub !== 'h' && sub !== 'v' && sub !== 'blur' && sub !== 'color') return;
      if (!style.textShadow) style.textShadow = {};
      if (trimmed) style.textShadow[sub] = trimmed;
      else delete style.textShadow[sub];
      if (Object.keys(style.textShadow).length === 0) delete style.textShadow;
      return;
    }
    if (head === 'columnOrder') {
      // Sub-key is the 0-based column index as a string. Accept only
      // non-negative integers — anything else silently no-ops so a stray
      // form path can't corrupt the slot.
      const idx = segments[1];
      if (!idx || !/^\d+$/.test(idx)) return;
      if (!style.columnOrder) style.columnOrder = {};
      if (trimmed) style.columnOrder[idx] = trimmed;
      else delete style.columnOrder[idx];
      if (Object.keys(style.columnOrder).length === 0) delete style.columnOrder;
      return;
    }
  }
}
