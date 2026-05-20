/**
 * Per-breakpoint CSS emission for the public renderer + the editor's
 * live preview.
 *
 *   - `buildBlockBreakpointCss`        → wrapper-level @media overrides
 *   - `buildBlockLinksCss`             → per-pseudo link sub-scope rules
 *   - `buildBlockNavMenuDesktopCss`    → ul/li/active inline-menu styling
 *   - `buildBlockBookmarkFolderCss`    → item/icon/desc tinting
 *   - `buildBlockArticlesListCss`      → card/title/meta tinting
 *   - `buildBlockColumnsCss`           → per-column `order` (default + per-BP)
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
  CARD_HOVER_GROUPS,
  LINK_SUBSCOPE_GROUPS,
  NAV_MENU_DESKTOP_GROUPS,
  NAV_MENU_UL_EXTRA_GROUPS,
  PORTFOLIO_GROUPS,
  STICKY_SUBSCOPE_GROUPS,
  WEBLOG_GROUPS,
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
  WEBLOG_KEYS,
  type ArticlesListKey,
  type BookmarkFolderKey,
  type CommonStyle,
  type NavMenuDesktopKey,
  type PortfolioKey,
  type PropertyEntry,
  type WeblogKey,
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

/** Flat schema for the card-hover sub-scope — same pre-resolve as the
 *  link sub-scope so `buildImportantInlineStyle` doesn't re-walk the
 *  group list on every block render. */
const CARD_HOVER_SCHEMA: PropertyEntry[] = CARD_HOVER_GROUPS
  .flatMap(g => flattenGroupProps(g.props));

/** Flat schema for the sticky-stuck sub-scope — same pre-resolve. */
const STICKY_SUBSCOPE_SCHEMA: PropertyEntry[] = STICKY_SUBSCOPE_GROUPS
  .flatMap(g => flattenGroupProps(g.props));

/** Same flat-schema treatment for the nav-menu desktop sub-scope
 *  (ul/li/aActive). Includes the `ul`-only extras (listStyleType etc.)
 *  in the union — they only emit when the user actually set them on the
 *  `ul` sub-key, since the panel only exposes them there. Keeping one
 *  shared schema avoids a per-key emit branch in `buildBlockNavMenuDesktopCss`. */
const NAV_MENU_DESKTOP_SCHEMA: PropertyEntry[] = [
  ...NAV_MENU_DESKTOP_GROUPS.flatMap(g => flattenGroupProps(g.props)),
  ...NAV_MENU_UL_EXTRA_GROUPS.flatMap(g => flattenGroupProps(g.props)),
];

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
  pageBtn:       PORTFOLIO_GROUPS.pageBtn.flatMap(g => flattenGroupProps(g.props)),
  pageBtnHover:  PORTFOLIO_GROUPS.pageBtnHover.flatMap(g => flattenGroupProps(g.props)),
  pageBtnActive: PORTFOLIO_GROUPS.pageBtnActive.flatMap(g => flattenGroupProps(g.props)),
};

/** CSS selector suffixes for the portfolio sub-scope keys. The close
 *  button lives inside the expanded card body — descendant scope keeps
 *  the rest of the portfolio markup untouched. */
const PORTFOLIO_SELECTORS: Record<PortfolioKey, string> = {
  closeBtn:      ' .nospress-block-portfolio__close',
  closeBtnHover: ' .nospress-block-portfolio__close:hover',
  pageBtn:       ' .nospress-block-portfolio__page-btn',
  pageBtnHover:  ' .nospress-block-portfolio__page-btn:hover',
  pageBtnActive: ' .nospress-block-portfolio__page-btn.is-active',
};

/** Flat per-key schemas for the weblog sub-scope. */
const WEBLOG_SCHEMAS: Record<WeblogKey, PropertyEntry[]> = {
  note:      WEBLOG_GROUPS.note.flatMap(g => flattenGroupProps(g.props)),
  noteHover: WEBLOG_GROUPS.noteHover.flatMap(g => flattenGroupProps(g.props)),
  isl:       WEBLOG_GROUPS.isl.flatMap(g => flattenGroupProps(g.props)),
  loading:   WEBLOG_GROUPS.loading.flatMap(g => flattenGroupProps(g.props)),
  meta:      WEBLOG_GROUPS.meta.flatMap(g => flattenGroupProps(g.props)),
  mention:   WEBLOG_GROUPS.mention.flatMap(g => flattenGroupProps(g.props)),
};

/** CSS selector suffixes for the weblog sub-scope keys. Each value is a
 *  list — most keys carry exactly one suffix, but `meta` fans out to
 *  three (timestamp + @handle + via-client) so a single color slot tints
 *  the whole byline strip. The build loop comma-joins all entries after
 *  prepending the wrapper selector. */
const WEBLOG_SELECTORS: Record<WeblogKey, string[]> = {
  note:      [' .note-card'],
  noteHover: [' .note-card:hover'],
  // `:not(:hover)` excludes the hover state so NoorNote's own
  // `.isl-action:hover { color: var(--color-5); background: var(--color-2); }`
  // takes over uninterrupted. Without this, the user's color override
  // would also apply on hover and collide with NoorNote's hover
  // background (text + bg in the same custom tint = invisible).
  isl:       [' .isl-action:not(:hover)'],
  loading:   [' .nospress-block-weblog__loading'],
  // The timestamp is rendered as `<time class="note-header__timestamp">
  // <span class="date-time">…</span></time>` via `formatTimestamp`. The
  // inner `.date-time` atom carries its own `color: var(--color-3)`, so
  // a rule on the outer `<time>` alone doesn't propagate — we target
  // both layers explicitly to win the cascade.
  meta:      [' .note-header__timestamp', ' .note-header__timestamp .date-time', ' .user-identity__handle', ' .note-header__client'],
  // The user-hover-card pops up when hovering a mention and is portaled
  // to `document.body`; it gets the same background tint so the pill
  // and its preview card read as one piece.
  mention:   [' .mention-link--bg', ' .user-hover-card'],
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
  block: { id: string; type: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle> },
  breakpoints: Array<{ name: string; type: 'min' | 'max' | 'between'; value: string; value2?: string }>,
): string {
  const schema = schemaFor(block.type);
  const parts: string[] = [];

  // Default-tab styles also emit as a regular (non-media) CSS rule —
  // not just as inline `style="…"` on the readonly wrapper. The editor
  // preview wrapper (`.nospress-block-style[data-styled-block-id]`)
  // carries the attribute but NOT the inline style, so without this
  // rule margin / padding / sizing / etc. set on the Default tab look
  // dead inside the editor. The same selector matches the readonly
  // wrapper too, but inline style there wins on specificity so this is
  // a no-op on the public page.
  const defaults = block.style;
  if (defaults) {
    const defaultDecls = buildInlineStyle(schema, defaults);
    if (defaultDecls) {
      parts.push(`[data-styled-block-id="${block.id}"] { ${defaultDecls} }`);
    }
  }

  const overrides = block.breakpointStyles;
  if (!overrides) return parts.join('\n');
  // Iterate the site-settings breakpoint array, NOT Object.entries on
  // the per-block overrides object. Equal-specificity @media rules
  // resolve by source order in the CSS, so the bundle must follow
  // site-settings order (where the user sorts smallest→broadest) — not
  // the per-block insertion order of style overrides. Mixing those two
  // produced the desktop-shows-tablet-l-value cascade bug (fixed
  // 2026-05-12) when the user typed values into the BP tabs in a
  // different order than the BPs sit in site-settings.
  for (const bp of breakpoints) {
    const style = overrides[bp.name];
    if (!style) continue;
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
    // Walk site-settings BP order so the cascade is well-defined; see
    // `buildBlockBreakpointCss` for the rationale.
    for (const bp of breakpoints) {
      const style = block.breakpointStyles[bp.name];
      if (!style) continue;
      const overrides = style.bookmarkFolder;
      if (!overrides) continue;
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

/** Per-block weblog sub-scope CSS — emits the user's tints for the
 *  rendered NoteUI list (`.note-card` default + hover; `.isl-action`
 *  color/background) scoped via `[data-styled-block-id="<id>"]`. Same
 *  Default + per-BP pattern as the other sub-scopes. */
export function buildBlockWeblogCss(
  block: { id: string; type: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle> },
  breakpoints: Array<{ name: string; type: 'min' | 'max' | 'between'; value: string; value2?: string }>,
): string {
  if (block.type !== 'weblog') return '';
  const sel = `[data-styled-block-id="${block.id}"]`;
  const parts: string[] = [];

  // `mention` is the lone exception in this fan-out: `.mention-link--bg`
  // appears both inside the rendered note content (scoped under the
  // wrapper) AND inside the Analytics modal that ModalService portals
  // to `document.body` (well outside the wrapper). Emit the rule global
  // for this key so both render paths pick up the user's tint. The
  // `<style>` block lives in the public-page container, so the rule
  // only ever loads on a NosPress site — not in the NoorNote app shell.
  const joinSel = (key: WeblogKey): string => key === 'mention'
    ? WEBLOG_SELECTORS[key].map(s => s.trimStart()).join(', ')
    : WEBLOG_SELECTORS[key].map(s => `${sel}${s}`).join(', ');

  const defaults = block.style?.weblog;
  if (defaults) {
    for (const key of WEBLOG_KEYS) {
      const sub = defaults[key];
      if (!sub) continue;
      // Use `!important` even for the Default-tab rules here — the weblog
      // sub-scopes target classes (`.note-card:hover`, `.isl-action`,
      // `.mention-link--bg`, …) that the rendered NoteUI / atom layer
      // also styles with state-specific rules. Specificity alone wins
      // most of those battles, but the rendered DOM occasionally adds
      // extra modifier classes (`.note-card--repost > .note-card:hover`
      // for nested reposts has spec 0,4,0 and outranks our 0,3,0). The
      // user explicitly set a value here, so it should always win.
      const decls = buildImportantInlineStyle(WEBLOG_SCHEMAS[key], sub);
      if (decls) parts.push(`${joinSel(key)} { ${decls} }`);
    }
  }

  if (block.breakpointStyles) {
    for (const bp of breakpoints) {
      const style = block.breakpointStyles[bp.name];
      if (!style) continue;
      const overrides = style.weblog;
      if (!overrides) continue;
      const mediaQuery = buildMediaQuery(bp);
      if (!mediaQuery) continue;
      const inner: string[] = [];
      for (const key of WEBLOG_KEYS) {
        const sub = overrides[key];
        if (!sub) continue;
        const decls = buildImportantInlineStyle(WEBLOG_SCHEMAS[key], sub);
        if (decls) inner.push(`${joinSel(key)} { ${decls} }`);
      }
      if (inner.length > 0) parts.push(`@media ${mediaQuery} { ${inner.join(' ')} }`);
    }
  }

  return parts.join('\n');
}

/** Per-block card `:hover` CSS — emits the user's hover-state styling
 *  scoped to this card instance via `[data-styled-block-id="<id>"]:hover`.
 *  `!important` always-on so the rule beats the molecule's own
 *  `.nn-card:hover` defaults (transform + box-shadow) which carry equal
 *  specificity (0,2,0). Default + per-BP pattern matches the other
 *  sub-scope emitters. */
export function buildBlockCardHoverCss(
  block: { id: string; type: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle> },
  breakpoints: Array<{ name: string; type: 'min' | 'max' | 'between'; value: string; value2?: string }>,
): string {
  if (block.type !== 'card') return '';
  const sel = `[data-styled-block-id="${block.id}"]:hover`;
  const parts: string[] = [];

  const defaults = block.style?.cardHover;
  if (defaults) {
    const decls = buildImportantInlineStyle(CARD_HOVER_SCHEMA, defaults);
    if (decls) parts.push(`${sel} { ${decls} }`);
  }

  if (block.breakpointStyles) {
    for (const bp of breakpoints) {
      const style = block.breakpointStyles[bp.name];
      if (!style?.cardHover) continue;
      const mediaQuery = buildMediaQuery(bp);
      if (!mediaQuery) continue;
      const decls = buildImportantInlineStyle(CARD_HOVER_SCHEMA, style.cardHover);
      if (decls) parts.push(`@media ${mediaQuery} { ${sel} { ${decls} } }`);
    }
  }

  return parts.join('\n');
}

/** Per-block sticky-stuck CSS — emits the user's stuck-state styling
 *  scoped to `[data-styled-block-id="<id>"].is-stuck`. The `.is-stuck`
 *  class is toggled at runtime by `stickyObserver.ts` via an
 *  IntersectionObserver sentinel pattern. `!important` is always-on so
 *  the rule beats the block's own inline-style (which carries the
 *  default-state values). Default + per-BP pattern matches the other
 *  sub-scope emitters. */
export function buildBlockStickyCss(
  block: { id: string; type: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle> },
  breakpoints: Array<{ name: string; type: 'min' | 'max' | 'between'; value: string; value2?: string }>,
): string {
  // Only emit when position=sticky on the Default tab — per-BP-only sticky
  // is rare and would need an @media-scoped sentinel/observer to avoid
  // false-positive `.is-stuck` toggles at the wrong viewport.
  if (block.style?.position !== 'sticky') return '';
  const stuckSel = `[data-styled-block-id="${block.id}"].is-stuck`;
  const parts: string[] = [];

  // Helper: build the link-pseudo selector under the `.is-stuck` scope,
  // matching the recent base-link cascade fix (`a, a:link` for the
  // `:link` slot so visited/hover inherit from the baseline).
  const stuckLinkSel = (pseudo: string): string =>
    pseudo === 'link' ? `${stuckSel} a, ${stuckSel} a:link` : `${stuckSel} a:${pseudo}`;

  const defaults = block.style?.sticky;
  if (defaults) {
    const decls = buildImportantInlineStyle(STICKY_SUBSCOPE_SCHEMA, defaults);
    if (decls) parts.push(`${stuckSel} { ${decls} }`);
    // Stuck-state link sub-scope: `style.sticky.links[pseudo]` →
    // `[id].is-stuck a:<pseudo> { … !important }`. Same per-pseudo loop
    // as `buildBlockLinksCss` but scoped under the stuck-state selector.
    const stickyLinks = defaults.links;
    if (stickyLinks) {
      for (const pseudo of LINK_PSEUDO_KEYS) {
        const linkStyle = stickyLinks[pseudo];
        if (!linkStyle) continue;
        const linkDecls = buildImportantInlineStyle(LINK_SUBSCOPE_SCHEMA, linkStyle);
        if (linkDecls) parts.push(`${stuckLinkSel(pseudo)} { ${linkDecls} }`);
      }
    }
  }

  if (block.breakpointStyles) {
    for (const bp of breakpoints) {
      const style = block.breakpointStyles[bp.name];
      if (!style?.sticky) continue;
      const mediaQuery = buildMediaQuery(bp);
      if (!mediaQuery) continue;
      const inner: string[] = [];
      const decls = buildImportantInlineStyle(STICKY_SUBSCOPE_SCHEMA, style.sticky);
      if (decls) inner.push(`${stuckSel} { ${decls} }`);
      const stickyLinks = style.sticky.links;
      if (stickyLinks) {
        for (const pseudo of LINK_PSEUDO_KEYS) {
          const linkStyle = stickyLinks[pseudo];
          if (!linkStyle) continue;
          const linkDecls = buildImportantInlineStyle(LINK_SUBSCOPE_SCHEMA, linkStyle);
          if (linkDecls) inner.push(`${stuckLinkSel(pseudo)} { ${linkDecls} }`);
        }
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
    for (const bp of breakpoints) {
      const style = block.breakpointStyles[bp.name];
      if (!style) continue;
      const overrides = style.portfolio;
      if (!overrides) continue;
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
    for (const bp of breakpoints) {
      const style = block.breakpointStyles[bp.name];
      if (!style) continue;
      const overrides = style.articlesList;
      if (!overrides) continue;
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
    for (const bp of breakpoints) {
      const style = block.breakpointStyles[bp.name];
      if (!style) continue;
      const overrides = style.navMenu;
      if (!overrides) continue;
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

  // The `:link` sub-scope intentionally emits BOTH `a` and `a:link` in the
  // selector list, so its declarations act as the BASELINE for every
  // anchor state — visited / hover / focus / active inherit (via the
  // bare-`a` half) and individual per-state sub-scopes only override what
  // they explicitly set. Without the bare `a`, `:link` only matches anchors
  // with an `href` AND no visited state, leaving `:visited` to fall back
  // to the browser default purple.
  const selectorFor = (pseudo: string): string =>
    pseudo === 'link' ? `${sel} a, ${sel} a:link` : `${sel} a:${pseudo}`;

  // Default-tab rules — applied at all viewports, no @media wrap, no
  // !important (they're the base, nothing to outrank).
  const defaultLinks = block.style?.links;
  if (defaultLinks) {
    for (const pseudo of LINK_PSEUDO_KEYS) {
      const linkStyle = defaultLinks[pseudo];
      if (!linkStyle) continue;
      const decls = buildInlineStyle(LINK_SUBSCOPE_SCHEMA, linkStyle);
      if (decls) parts.push(`${selectorFor(pseudo)} { ${decls} }`);
    }
  }

  // Per-BP overrides — wrapped in @media, declarations get !important
  // so they outrank the Default-tab rules above.
  if (block.breakpointStyles) {
    for (const bp of breakpoints) {
      const style = block.breakpointStyles[bp.name];
      if (!style) continue;
      const linkOverrides = style.links;
      if (!linkOverrides) continue;
      const mediaQuery = buildMediaQuery(bp);
      if (!mediaQuery) continue;
      const inner: string[] = [];
      for (const pseudo of LINK_PSEUDO_KEYS) {
        const linkStyle = linkOverrides[pseudo];
        if (!linkStyle) continue;
        const decls = buildImportantInlineStyle(LINK_SUBSCOPE_SCHEMA, linkStyle);
        if (decls) inner.push(`${selectorFor(pseudo)} { ${decls} }`);
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
    for (const bp of breakpoints) {
      const style = block.breakpointStyles[bp.name];
      if (!style) continue;
      const bg = style.background;
      if (!bg) continue;
      const mq = buildMediaQuery(bp);
      if (!mq) continue;
      const v = sanitizeStyleValue(bg);
      if (v) parts.push(`@media ${mq} { ${sel} { background: ${v} !important; } }`);
    }
  }

  return parts.join('\n');
}

/** Emit per-column CSS `order` rules for the `columns` block. Targets each
 *  `> .nospress-block-columns__col:nth-child(I+1)` separately because the
 *  `order` declaration cannot ride along on the block wrapper — it has to
 *  land on the grid item.
 *
 *  Default-tab values render as plain (non-media) rules so the editor
 *  preview wrapper picks them up live. Per-BP overrides emit as `@media`
 *  rules with `!important` so they outrank the Default rule when the
 *  matching breakpoint kicks in.
 *
 *  Sparse: only indices that actually carry a value emit a rule. */
export function buildBlockColumnsCss(
  block: { id: string; type: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle> },
  breakpoints: Array<{ name: string; type: 'min' | 'max' | 'between'; value: string; value2?: string }>,
): string {
  if (block.type !== 'columns') return '';
  const sel = `[data-styled-block-id="${block.id}"] > .nospress-block-columns__col`;
  const parts: string[] = [];

  const emit = (orders: { [idx: string]: string } | undefined, important: boolean): string[] => {
    if (!orders) return [];
    const rules: string[] = [];
    for (const [key, raw] of Object.entries(orders)) {
      if (!/^\d+$/.test(key)) continue;
      const value = sanitizeStyleValue(raw);
      if (!value) continue;
      const nth = parseInt(key, 10) + 1;
      const decl = important ? `order: ${value} !important` : `order: ${value}`;
      rules.push(`${sel}:nth-child(${nth}) { ${decl} }`);
    }
    return rules;
  };

  parts.push(...emit(block.style?.columnOrder, false));

  if (block.breakpointStyles) {
    // Walk site-settings BP order so the cascade is well-defined; same
    // rationale as `buildBlockBreakpointCss`.
    for (const bp of breakpoints) {
      const bpStyle = block.breakpointStyles[bp.name];
      if (!bpStyle) continue;
      const rules = emit(bpStyle.columnOrder, true);
      if (rules.length === 0) continue;
      const mediaQuery = buildMediaQuery(bp);
      if (!mediaQuery) continue;
      parts.push(`@media ${mediaQuery} { ${rules.join(' ')} }`);
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
        const weblogCss = buildBlockWeblogCss(blockTyped, breakpoints);
        if (weblogCss) out.push(weblogCss);
        const cardHoverCss = buildBlockCardHoverCss(blockTyped, breakpoints);
        if (cardHoverCss) out.push(cardHoverCss);
        const stickyCss = buildBlockStickyCss(blockTyped, breakpoints);
        if (stickyCss) out.push(stickyCss);
        const columnsCss = buildBlockColumnsCss(blockTyped, breakpoints);
        if (columnsCss) out.push(columnsCss);
      }
      // Recurse into containers
      if (b.type === 'columns' && Array.isArray((b as { content?: unknown }).content)) {
        for (const col of (b as { content: Array<unknown[]> }).content) {
          walk(col as never);
        }
      } else if (b.type === 'div' && Array.isArray((b as { children?: unknown }).children)) {
        walk((b as { children: never[] }).children);
      } else if (b.type === 'card' && Array.isArray((b as { children?: unknown }).children)) {
        walk((b as { children: never[] }).children);
      }
    }
  };
  walk(blocks as never);
  return out.join('\n');
}
