/**
 * Per-breakpoint CSS emission for the public renderer + the editor's
 * live preview.
 *
 *   - `buildBlockBreakpointCss`        → wrapper-level @media overrides
 *   - `buildBlockLinksCss`             → per-pseudo link sub-scope rules
 *   - `buildBlockNavMenuDesktopCss`    → ul/li/active inline-menu styling
 *   - `buildBlockBookmarkFolderCss`    → item/icon/desc tinting
 *   - `buildBlockArticlesListCss`      → card/title/meta tinting
 *   - `buildPageBreakpointCss`         → walk a whole block tree, emit
 *                                        a single combined CSS string
 *
 * Sub-scope schemas (LINK / NAV_MENU_DESKTOP / BOOKMARK_FOLDER /
 * ARTICLES_LIST) are pre-resolved at module load so the per-block CSS
 * emit pipeline doesn't re-walk the group list on every render.
 */

import { buildImportantInlineStyle, buildInlineStyle } from './build';
import {
  ARTICLES_LIST_GROUPS,
  BOOKMARK_FOLDER_GROUPS,
  LINK_SUBSCOPE_GROUPS,
  NAV_MENU_DESKTOP_GROUPS,
  PORTFOLIO_GROUPS,
  flattenGroupProps,
  schemaFor,
} from './catalog';
import { sanitizeStyleValue } from './sanitize';
import {
  ARTICLES_LIST_KEYS,
  BLOCKS_WITH_LINKS_SUBSCOPE,
  BOOKMARK_FOLDER_KEYS,
  LINK_PSEUDO_KEYS,
  NAV_MENU_DESKTOP_KEYS,
  PORTFOLIO_KEYS,
  type ArticlesListKey,
  type BookmarkFolderKey,
  type CommonStyle,
  type NavMenuDesktopKey,
  type PortfolioKey,
  type PropertyEntry,
} from './types';

// ──────────────────────────────────────────────────────────────────────────
// Pre-resolved flat sub-scope schemas
// ──────────────────────────────────────────────────────────────────────────

/** Flat schema for the link sub-scope — derived once from
 *  `LINK_SUBSCOPE_GROUPS` so `buildInlineStyle` /
 *  `buildImportantInlineStyle` can be called per-pseudo-class without
 *  re-resolving the group list every time. */
const LINK_SUBSCOPE_SCHEMA: PropertyEntry[] = LINK_SUBSCOPE_GROUPS
  .flatMap(g => flattenGroupProps(g.props));

/** Same flat-schema treatment for the nav-menu desktop sub-scope
 *  (ul/li). Currently identical to LINK_SUBSCOPE_SCHEMA — kept as a
 *  separate symbol so future divergence stays cheap. */
const NAV_MENU_DESKTOP_SCHEMA: PropertyEntry[] = NAV_MENU_DESKTOP_GROUPS
  .flatMap(g => flattenGroupProps(g.props));

/** Flat per-key schemas for the bookmark-folder sub-scope. Each entry
 *  is the single PropertyEntry the section exposes (background for
 *  item, color for icon/desc). */
const BOOKMARK_FOLDER_SCHEMAS: Record<BookmarkFolderKey, PropertyEntry[]> = {
  item: BOOKMARK_FOLDER_GROUPS.item.flatMap(g => flattenGroupProps(g.props)),
  icon: BOOKMARK_FOLDER_GROUPS.icon.flatMap(g => flattenGroupProps(g.props)),
  desc: BOOKMARK_FOLDER_GROUPS.desc.flatMap(g => flattenGroupProps(g.props)),
};

/** CSS selector suffixes for the bookmark-folder sub-scope keys. The
 *  rendered list lives inside `[data-styled-block-id="X"]` so all
 *  selectors stay descendant-scoped. */
const BOOKMARK_FOLDER_SELECTORS: Record<BookmarkFolderKey, string> = {
  item: ' .profile-list-item',
  icon: ' .profile-list-item__icon',
  desc: ' .profile-list-item__desc',
};

const ARTICLES_LIST_SCHEMAS: Record<ArticlesListKey, PropertyEntry[]> = {
  card:  ARTICLES_LIST_GROUPS.card.flatMap(g => flattenGroupProps(g.props)),
  title: ARTICLES_LIST_GROUPS.title.flatMap(g => flattenGroupProps(g.props)),
  meta:  ARTICLES_LIST_GROUPS.meta.flatMap(g => flattenGroupProps(g.props)),
};

const ARTICLES_LIST_SELECTORS: Record<ArticlesListKey, string> = {
  card:  ' .nn-card',
  title: ' .nn-card h3',
  meta:  ' .nn-card .meta',
};

/** Flat per-key schemas for the portfolio sub-scope. Two slots
 *  (closeBtn / closeBtnHover) each exposing icon color + circle
 *  background. */
const PORTFOLIO_SCHEMAS: Record<PortfolioKey, PropertyEntry[]> = {
  closeBtn:      PORTFOLIO_GROUPS.closeBtn.flatMap(g => flattenGroupProps(g.props)),
  closeBtnHover: PORTFOLIO_GROUPS.closeBtnHover.flatMap(g => flattenGroupProps(g.props)),
};

/** CSS selector suffixes for the portfolio sub-scope keys. The close
 *  button lives inside the expanded card body — descendant scope keeps
 *  the rest of the portfolio markup untouched. */
const PORTFOLIO_SELECTORS: Record<PortfolioKey, string> = {
  closeBtn:      ' .nospress-block-portfolio__close',
  closeBtnHover: ' .nospress-block-portfolio__close:hover',
};

/** Per-key CSS selector suffixes for the nav-menu desktop sub-scope.
 *  Selector is `[data-styled-block-id="X"]<suffix>`. Descendant
 *  selectors so the portaled hamburger drawer (which carries the
 *  attribute on itself, not as ancestor) is NOT matched. */
const NAV_MENU_DESKTOP_SELECTORS: Record<NavMenuDesktopKey, string> = {
  ul:      ' ul',
  li:      ' li',
  aActive: ' li.active a',
};

// ──────────────────────────────────────────────────────────────────────────
// Builders
// ──────────────────────────────────────────────────────────────────────────

/** Build a CSS string for a single block's per-breakpoint style overrides.
 *  Returns an array of @media-wrapped rule sets — one per breakpoint that
 *  has a non-empty override slot. Selectors target the wrapper via
 *  `[data-styled-block-id="<uuid>"]`, and each declaration is suffixed
 *  with `!important` so the override outranks the wrapper's inline
 *  `style="…"` (which carries the base / Default-tab styles).
 *
 *  Empty / unknown breakpoint names are skipped silently — happens after
 *  the user deletes a breakpoint without touching every block that
 *  referenced it. */
export function buildBlockBreakpointCss(
  block: { id: string; type: string; breakpointStyles?: Record<string, CommonStyle> },
  breakpoints: Array<{ name: string; type: 'min' | 'max' | 'between'; value: string; value2?: string }>,
): string {
  const overrides = block.breakpointStyles;
  if (!overrides) return '';
  const byName = new Map(breakpoints.map(bp => [bp.name, bp]));
  const schema = schemaFor(block.type);
  const parts: string[] = [];
  for (const [name, style] of Object.entries(overrides)) {
    const bp = byName.get(name);
    if (!bp) continue;
    const declarations = buildImportantInlineStyle(schema, style);
    if (!declarations) continue;
    const mediaQuery = buildMediaQuery(bp);
    if (!mediaQuery) continue;
    parts.push(
      `@media ${mediaQuery} { [data-styled-block-id="${block.id}"] { ${declarations} } }`,
    );
  }
  return parts.join('\n');
}

export function buildBlockBookmarkFolderCss(
  block: { id: string; type: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle> },
  breakpoints: Array<{ name: string; type: 'min' | 'max' | 'between'; value: string; value2?: string }>,
): string {
  if (block.type !== 'bookmark-folder') return '';
  const sel = `[data-styled-block-id="${block.id}"]`;
  const parts: string[] = [];

  const defaults = block.style?.bookmarkFolder;
  if (defaults) {
    for (const key of BOOKMARK_FOLDER_KEYS) {
      const sub = defaults[key];
      if (!sub) continue;
      const decls = buildInlineStyle(BOOKMARK_FOLDER_SCHEMAS[key], sub);
      if (decls) parts.push(`${sel}${BOOKMARK_FOLDER_SELECTORS[key]} { ${decls} }`);
    }
  }

  if (block.breakpointStyles) {
    const byName = new Map(breakpoints.map(bp => [bp.name, bp]));
    for (const [bpName, style] of Object.entries(block.breakpointStyles)) {
      const overrides = style.bookmarkFolder;
      if (!overrides) continue;
      const bp = byName.get(bpName);
      if (!bp) continue;
      const mediaQuery = buildMediaQuery(bp);
      if (!mediaQuery) continue;
      const inner: string[] = [];
      for (const key of BOOKMARK_FOLDER_KEYS) {
        const sub = overrides[key];
        if (!sub) continue;
        const decls = buildImportantInlineStyle(BOOKMARK_FOLDER_SCHEMAS[key], sub);
        if (decls) inner.push(`${sel}${BOOKMARK_FOLDER_SELECTORS[key]} { ${decls} }`);
      }
      if (inner.length > 0) parts.push(`@media ${mediaQuery} { ${inner.join(' ')} }`);
    }
  }

  return parts.join('\n');
}

/** Per-block portfolio sub-scope CSS — emits the user's close-button
 *  tints (default + hover state) scoped to this portfolio instance via
 *  `[data-styled-block-id="<id>"]`. Same Default + per-BP pattern as
 *  the other sub-scopes. */
export function buildBlockPortfolioCloseBtnCss(
  block: { id: string; type: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle> },
  breakpoints: Array<{ name: string; type: 'min' | 'max' | 'between'; value: string; value2?: string }>,
): string {
  if (block.type !== 'portfolio') return '';
  const sel = `[data-styled-block-id="${block.id}"]`;
  const parts: string[] = [];

  const defaults = block.style?.portfolio;
  if (defaults) {
    for (const key of PORTFOLIO_KEYS) {
      const sub = defaults[key];
      if (!sub) continue;
      const decls = buildInlineStyle(PORTFOLIO_SCHEMAS[key], sub);
      if (decls) parts.push(`${sel}${PORTFOLIO_SELECTORS[key]} { ${decls} }`);
    }
  }

  if (block.breakpointStyles) {
    const byName = new Map(breakpoints.map(bp => [bp.name, bp]));
    for (const [bpName, style] of Object.entries(block.breakpointStyles)) {
      const overrides = style.portfolio;
      if (!overrides) continue;
      const bp = byName.get(bpName);
      if (!bp) continue;
      const mediaQuery = buildMediaQuery(bp);
      if (!mediaQuery) continue;
      const inner: string[] = [];
      for (const key of PORTFOLIO_KEYS) {
        const sub = overrides[key];
        if (!sub) continue;
        const decls = buildImportantInlineStyle(PORTFOLIO_SCHEMAS[key], sub);
        if (decls) inner.push(`${sel}${PORTFOLIO_SELECTORS[key]} { ${decls} }`);
      }
      if (inner.length > 0) parts.push(`@media ${mediaQuery} { ${inner.join(' ')} }`);
    }
  }

  return parts.join('\n');
}

export function buildBlockArticlesListCss(
  block: { id: string; type: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle> },
  breakpoints: Array<{ name: string; type: 'min' | 'max' | 'between'; value: string; value2?: string }>,
): string {
  if (block.type !== 'articles-list') return '';
  const sel = `[data-styled-block-id="${block.id}"]`;
  const parts: string[] = [];

  const defaults = block.style?.articlesList;
  if (defaults) {
    for (const key of ARTICLES_LIST_KEYS) {
      const sub = defaults[key];
      if (!sub) continue;
      const decls = buildInlineStyle(ARTICLES_LIST_SCHEMAS[key], sub);
      if (decls) parts.push(`${sel}${ARTICLES_LIST_SELECTORS[key]} { ${decls} }`);
    }
  }

  if (block.breakpointStyles) {
    const byName = new Map(breakpoints.map(bp => [bp.name, bp]));
    for (const [bpName, style] of Object.entries(block.breakpointStyles)) {
      const overrides = style.articlesList;
      if (!overrides) continue;
      const bp = byName.get(bpName);
      if (!bp) continue;
      const mediaQuery = buildMediaQuery(bp);
      if (!mediaQuery) continue;
      const inner: string[] = [];
      for (const key of ARTICLES_LIST_KEYS) {
        const sub = overrides[key];
        if (!sub) continue;
        const decls = buildImportantInlineStyle(ARTICLES_LIST_SCHEMAS[key], sub);
        if (decls) inner.push(`${sel}${ARTICLES_LIST_SELECTORS[key]} { ${decls} }`);
      }
      if (inner.length > 0) parts.push(`@media ${mediaQuery} { ${inner.join(' ')} }`);
    }
  }

  return parts.join('\n');
}

/** Emit per-block nav-menu desktop sub-scope CSS rules — `<ul>` and
 *  `<li>` styling for the inline rendering. Same Default + per-BP
 *  pattern as the link sub-scope. Scope is the wrapper attribute
 *  selector + descendant `ul` / `li`, so the portaled hamburger drawer
 *  (which carries the attribute on itself, not as ancestor) is NOT
 *  matched — the drawer is styled via the mobile-menu sub-scope. */
export function buildBlockNavMenuDesktopCss(
  block: { id: string; type: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle> },
  breakpoints: Array<{ name: string; type: 'min' | 'max' | 'between'; value: string; value2?: string }>,
): string {
  if (block.type !== 'nav-menu') return '';
  const sel = `[data-styled-block-id="${block.id}"]`;
  const parts: string[] = [];

  const defaultNav = block.style?.navMenu;
  if (defaultNav) {
    for (const key of NAV_MENU_DESKTOP_KEYS) {
      const sub = defaultNav[key];
      if (!sub) continue;
      const decls = buildInlineStyle(NAV_MENU_DESKTOP_SCHEMA, sub);
      if (decls) parts.push(`${sel}${NAV_MENU_DESKTOP_SELECTORS[key]} { ${decls} }`);
    }
  }

  if (block.breakpointStyles) {
    const byName = new Map(breakpoints.map(bp => [bp.name, bp]));
    for (const [bpName, style] of Object.entries(block.breakpointStyles)) {
      const overrides = style.navMenu;
      if (!overrides) continue;
      const bp = byName.get(bpName);
      if (!bp) continue;
      const mediaQuery = buildMediaQuery(bp);
      if (!mediaQuery) continue;
      const inner: string[] = [];
      for (const key of NAV_MENU_DESKTOP_KEYS) {
        const sub = overrides[key];
        if (!sub) continue;
        const decls = buildImportantInlineStyle(NAV_MENU_DESKTOP_SCHEMA, sub);
        if (decls) inner.push(`${sel}${NAV_MENU_DESKTOP_SELECTORS[key]} { ${decls} }`);
      }
      if (inner.length > 0) parts.push(`@media ${mediaQuery} { ${inner.join(' ')} }`);
    }
  }

  return parts.join('\n');
}

/** Emit per-block link sub-scope CSS rules for both the Default tab
 *  (`block.style.links.<pseudo>` → unwrapped rules) and per-BP
 *  overrides (`block.breakpointStyles[bp].links.<pseudo>` →
 *  @media-wrapped `!important` rules). Scope is the wrapper attribute
 *  selector + descendant `a:<pseudo>` so the rules apply only to links
 *  rendered inside this block. */
export function buildBlockLinksCss(
  block: { id: string; type: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle> },
  breakpoints: Array<{ name: string; type: 'min' | 'max' | 'between'; value: string; value2?: string }>,
): string {
  if (!BLOCKS_WITH_LINKS_SUBSCOPE.has(block.type)) return '';
  const sel = `[data-styled-block-id="${block.id}"]`;
  const parts: string[] = [];

  // Default-tab rules — applied at all viewports, no @media wrap, no
  // !important (they're the base, nothing to outrank).
  const defaultLinks = block.style?.links;
  if (defaultLinks) {
    for (const pseudo of LINK_PSEUDO_KEYS) {
      const linkStyle = defaultLinks[pseudo];
      if (!linkStyle) continue;
      const decls = buildInlineStyle(LINK_SUBSCOPE_SCHEMA, linkStyle);
      if (decls) parts.push(`${sel} a:${pseudo} { ${decls} }`);
    }
  }

  // Per-BP overrides — wrapped in @media, declarations get !important
  // so they outrank the Default-tab rules above.
  if (block.breakpointStyles) {
    const byName = new Map(breakpoints.map(bp => [bp.name, bp]));
    for (const [bpName, style] of Object.entries(block.breakpointStyles)) {
      const linkOverrides = style.links;
      if (!linkOverrides) continue;
      const bp = byName.get(bpName);
      if (!bp) continue;
      const mediaQuery = buildMediaQuery(bp);
      if (!mediaQuery) continue;
      const inner: string[] = [];
      for (const pseudo of LINK_PSEUDO_KEYS) {
        const linkStyle = linkOverrides[pseudo];
        if (!linkStyle) continue;
        const decls = buildImportantInlineStyle(LINK_SUBSCOPE_SCHEMA, linkStyle);
        if (decls) inner.push(`${sel} a:${pseudo} { ${decls} }`);
      }
      if (inner.length > 0) parts.push(`@media ${mediaQuery} { ${inner.join(' ')} }`);
    }
  }

  return parts.join('\n');
}

/** Portfolio card background — `block.style.background` is intentionally
 *  stripped from the wrapper's inline / per-BP CSS (see
 *  `WRAPPER_SKIP_PROPS` in catalog.ts) and re-emitted here as a
 *  card-scoped rule. Per-BP overrides ride `@media` + `!important` like
 *  the other sub-scope builders. */
export function buildBlockPortfolioCardCss(
  block: { id: string; type: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle> },
  breakpoints: Array<{ name: string; type: 'min' | 'max' | 'between'; value: string; value2?: string }>,
): string {
  if (block.type !== 'portfolio') return '';
  const sel = `[data-styled-block-id="${block.id}"] .nospress-block-portfolio__card`;
  const parts: string[] = [];

  const def = block.style?.background;
  if (def) {
    const v = sanitizeStyleValue(def);
    if (v) parts.push(`${sel} { background: ${v}; }`);
  }

  if (block.breakpointStyles) {
    const byName = new Map(breakpoints.map(bp => [bp.name, bp]));
    for (const [bpName, style] of Object.entries(block.breakpointStyles)) {
      const bg = style.background;
      if (!bg) continue;
      const bp = byName.get(bpName);
      if (!bp) continue;
      const mq = buildMediaQuery(bp);
      if (!mq) continue;
      const v = sanitizeStyleValue(bg);
      if (v) parts.push(`@media ${mq} { ${sel} { background: ${v} !important; } }`);
    }
  }

  return parts.join('\n');
}

/** Compose a single CSS `@media (...)` clause for a user-defined breakpoint. */
function buildMediaQuery(bp: { type: 'min' | 'max' | 'between'; value: string; value2?: string }): string | null {
  const v1 = sanitizeStyleValue(bp.value);
  if (!v1) return null;
  if (bp.type === 'min') return `(min-width: ${v1})`;
  if (bp.type === 'max') return `(max-width: ${v1})`;
  if (bp.type === 'between') {
    const v2 = sanitizeStyleValue(bp.value2 ?? '');
    if (!v2) return null;
    return `(min-width: ${v1}) and (max-width: ${v2})`;
  }
  return null;
}

/** Walk an entire block tree and concatenate per-breakpoint CSS. Used by
 *  the public renderer to emit a single `<style>` block alongside the
 *  rendered HTML. */
export function buildPageBreakpointCss(
  blocks: Array<{ id: string; type: string; breakpointStyles?: Record<string, CommonStyle> } & Record<string, unknown>>,
  breakpoints: Array<{ name: string; type: 'min' | 'max' | 'between'; value: string; value2?: string }>,
): string {
  // Default-tab link sub-scope rules emit even when the user has no
  // breakpoints defined yet — they are unwrapped CSS rules, not @media
  // queries. Per-BP overrides need the breakpoint list to resolve, so
  // they're skipped silently when the array is empty.
  const out: string[] = [];
  const walk = (list: Array<{ id?: string; type?: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle> } & Record<string, unknown>>) => {
    for (const b of list) {
      if (b.type && b.id) {
        const blockTyped = b as { id: string; type: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle> };
        const bpCss = buildBlockBreakpointCss(blockTyped, breakpoints);
        if (bpCss) out.push(bpCss);
        const navMenuCss = buildBlockNavMenuDesktopCss(blockTyped, breakpoints);
        if (navMenuCss) out.push(navMenuCss);
        const linksCss = buildBlockLinksCss(blockTyped, breakpoints);
        if (linksCss) out.push(linksCss);
        const bookmarkFolderCss = buildBlockBookmarkFolderCss(blockTyped, breakpoints);
        if (bookmarkFolderCss) out.push(bookmarkFolderCss);
        const articlesListCss = buildBlockArticlesListCss(blockTyped, breakpoints);
        if (articlesListCss) out.push(articlesListCss);
        const portfolioCardCss = buildBlockPortfolioCardCss(blockTyped, breakpoints);
        if (portfolioCardCss) out.push(portfolioCardCss);
        const portfolioCloseBtnCss = buildBlockPortfolioCloseBtnCss(blockTyped, breakpoints);
        if (portfolioCloseBtnCss) out.push(portfolioCloseBtnCss);
      }
      // Recurse into containers
      if (b.type === 'columns' && Array.isArray((b as { content?: unknown }).content)) {
        for (const col of (b as { content: Array<unknown[]> }).content) {
          walk(col as never);
        }
      } else if (b.type === 'div' && Array.isArray((b as { children?: unknown }).children)) {
        walk((b as { children: never[] }).children);
      }
    }
  };
  walk(blocks as never);
  return out.join('\n');
}
