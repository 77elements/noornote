/**
 * NosPress style-system — shared type definitions.
 *
 * Pure types + key constants used across the engine (catalog, build,
 * access, breakpointCss, styleWrap) and the Properties-UI (panel,
 * sections, colorPicker). No runtime logic here — `import type` from
 * this module wherever possible so the bundler can erase the import.
 */

// ──────────────────────────────────────────────────────────────────────────
// Box / divider primitives
// ──────────────────────────────────────────────────────────────────────────

export interface BoxValues {
  top?: string;
  bottom?: string;
  left?: string;
  right?: string;
}

/** Decorative divider shape applied as a `clip-path` on the wrapper's
 *  top or bottom edge. Each entry resolves through `DIVIDER_CATALOG` to
 *  a polygon-style cut — what sits behind the wrapper (the page body,
 *  next section, …) shows through, no color picker needed. */
export type DividerStyle =
  | 'none'
  | 'slant'
  | 'curve'
  | 'curve-asymmetric'
  | 'triangle'
  | 'triangle-asymmetric'
  | 'wave'
  | 'wave-double'
  | 'mountains'
  | 'notch';

// ──────────────────────────────────────────────────────────────────────────
// CommonStyle — every block's style payload
// ──────────────────────────────────────────────────────────────────────────

/**
 * Common style payload — the same shape applies to the Page and to any
 * block-level style. Strict superset is fine: blocks can only set
 * properties listed in their STYLE_MATRIX row, but the type here stays
 * unified so the helpers don't need to be parameterised.
 */
export interface CommonStyle {
  color?: string;
  background?: string;
  fontSize?: string;
  lineHeight?: string;
  fontWeight?: string;
  fontStyle?: string;
  /** CSS `text-align` (left / center / right / justify). Surfaced only
   *  for heading + text blocks in the Properties panel (the other
   *  textual blocks have layout-driven content where left-default is
   *  the right call). */
  textAlign?: string;
  /** CSS `position` mode (static / relative / absolute / fixed / sticky).
   *  Always defaults to `static` (the CSS default for every element). */
  position?: string;
  /** Per-side `top` / `right` / `bottom` / `left` offsets — only
   *  meaningful when `position` is `absolute` / `fixed` / `sticky` /
   *  `relative`. Surfaced in the panel only for `absolute` / `sticky`
   *  (the cases the user asked for). */
  positionInsets?: BoxValues;
  /** CSS `display` mode — pre-filled in the panel with the block's
   *  natural default (e.g. `block` for headings, `inline-block` for
   *  buttons). Only written to inline styles when the user picks
   *  something explicit. */
  display?: string;
  /** CSS `gap` for grid containers. Surfaced in the panel only when the
   *  effective `display` is `grid` — for any other display the property
   *  has no effect, so cluttering the panel with it would just confuse.
   *  CSS default is `0`; the panel placeholder mirrors that so users see
   *  what they'd be overriding. */
  gridGap?: string;
  /** Per-side border widths (CSS shorthand emitted as
   *  `border-width: <top> <right> <bottom> <left>`). */
  borderWidth?: BoxValues;
  /** Single border style (solid / dashed / dotted / double) — applies to
   *  all sides. CSS-style-specific 3D effects (groove/ridge/inset/outset)
   *  intentionally omitted; `none` is represented by absence. */
  borderStyle?: string;
  /** Per-side border colours — same quad shape as widths. */
  borderColor?: BoxValues;
  borderRadius?: string;
  /** Legacy `border` shorthand string (e.g. `'1px solid #ede2da'`). Kept
   *  on the type so reads of older saved data don't error; auto-migrated
   *  to `borderWidth/Style/Color` on the next write. */
  border?: string;
  /** Text shadow — composed at render time as
   *  `<h> <v> <blur> <color>` from sub-fields. Each input is independent
   *  so the user can leave fields empty and the renderer fills with
   *  sensible defaults (`0` for offsets/blur, `black` for color). The
   *  property emits only when at least one sub-field is set. */
  textShadow?: { h?: string; v?: string; blur?: string; color?: string };
  /** CSS `width` — universally available across text-flow + container
   *  blocks so users can constrain elements to custom widths (e.g. a
   *  narrow centered Heading, a 60ch reading column, a 800px hero band). */
  width?: string;
  /** CSS `height` — exposed only on container/media blocks where a fixed
   *  height makes sense (hero divs, sized image placeholders, video boxes).
   *  Skipped on text-flow blocks because forcing height on prose-style
   *  blocks tends to clip content unexpectedly. */
  height?: string;
  margin?: BoxValues;
  padding?: BoxValues;
  /** Top / bottom edge dividers — available only on the `div` block scope
   *  (and its HTML-tag variants header/footer/main/section/nav etc.).
   *  Value per side is the style identifier directly; height + cut path
   *  come from `DIVIDER_CATALOG`. `flipX` mirrors every divider on this
   *  block horizontally (x → 100−x), `flipY` vertically (y → 10−y).
   *  Both can be combined. Doubles/quadruples the effective shape variety
   *  without growing the catalog. */
  divider?: { top?: DividerStyle; bottom?: DividerStyle; flipX?: boolean; flipY?: boolean };
  /** Nav-menu mobile drawer sub-scope styling. Each section maps to a
   *  selector on the rendered drawer DOM:
   *    - `ul`        → `.nospress-nav-menu__list[data-styled-block-id=X]`
   *    - `li`        → `.nospress-nav-menu__list[..=X] li`
   *    - `a`         → `.nospress-nav-menu__list[..=X] li a`
   *    - `aActive`   → `.nospress-nav-menu__list[..=X] li.active a`
   *    - `hamburger` → `[..=X] .nospress-nav-menu__hamburger`
   *    - `overlay`   → `.nospress-nav-menu__overlay[..=X]`
   *
   *  The sub-scope panel is opened by the hamburger trigger on the block
   *  and renders one accordion section per selector, each containing the
   *  standard property groups (Spacing/Sizing/Typography/Background/Border).
   *
   *  Each section's value is itself a `CommonStyle` so all the standard
   *  property machinery (writeStyleField/buildInlineStyle/etc.) works
   *  recursively — the only twist is that read/writeStyleField walk a
   *  3-or-4 segment dotted path (`mobileMenu.<sec>.<prop>[.subKey]`). */
  mobileMenu?: Partial<Record<MobileMenuSection, CommonStyle>>;
  /** Per-block hyperlink styling — each pseudo-class (`:link` / `:visited`
   *  / `:hover` / `:focus` / `:active`) takes a full `CommonStyle` slice
   *  applied to descendant `<a>` elements via the wrapper's
   *  `[data-styled-block-id]` scope. Same recursive pattern as
   *  `mobileMenu` — read/writeStyleField walks `links.<pseudo>.<rest>`. */
  links?: Partial<Record<LinkPseudo, CommonStyle>>;
  /** Nav-menu desktop sub-scope — `ul` + `li` styling for the inline
   *  rendering (NOT the portaled hamburger drawer; that's `mobileMenu`).
   *  Selector targets the descendant `<ul>` / `<li>` of the block
   *  wrapper, so the portaled drawer (which carries `data-styled-block-id`
   *  on itself, not as ancestor) is unaffected. Only surfaced for the
   *  nav-menu block in the Properties panel. */
  navMenu?: Partial<Record<NavMenuDesktopKey, CommonStyle>>;
  /** Bookmark-folder sub-scope — narrow per-element styling slots inside
   *  the rendered list (`.profile-list-item` item row, its icon, its
   *  description). Each slot is restricted to ONE property only (item
   *  → background, icon → color, desc → color) so the NoorNote default
   *  look stays mostly intact; the user just retints. Surfaced for the
   *  bookmark-folder block in the Properties panel. */
  bookmarkFolder?: Partial<Record<BookmarkFolderKey, CommonStyle>>;
  /** Articles-list sub-scope — narrow per-element styling slots inside
   *  the rendered carousel of `.nn-card` article tiles. Same pattern
   *  as `bookmarkFolder`: one property per slot (card → background,
   *  title → color, meta → color). */
  articlesList?: Partial<Record<ArticlesListKey, CommonStyle>>;
  /** CSS `text-decoration` (none / underline / overline / line-through).
   *  Applies to the block itself in regular Typography AND to any link
   *  sub-scope where overriding the underline is the most common case. */
  textDecoration?: string;
  /** Horizontal placement of an inline-block child within its parent — used
   *  by the `dm-button` block to position the button left / center / right
   *  inside the page flow. Emitted as `text-align` on an outer wrapper DIV
   *  (NOT on the button itself, which is inline-flex and would only
   *  affect its own text content). Labelled "Align Button" in the
   *  Properties panel so it isn't confused with text-alignment of label
   *  content. */
  alignButton?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Sub-scope key constants
// ──────────────────────────────────────────────────────────────────────────

/** Selectors covered by the mobile-menu sub-scope. Order is the
 *  display order of the accordion sections in the property panel. */
export const MOBILE_MENU_SECTION_KEYS = ['ul', 'li', 'a', 'aActive', 'hamburger', 'overlay'] as const;
export type MobileMenuSection = typeof MOBILE_MENU_SECTION_KEYS[number];

/** Pseudo-class slots covered by the per-block link sub-scope. Order is
 *  the display order of the accordion sections in the property panel. */
export const LINK_PSEUDO_KEYS = ['link', 'visited', 'hover', 'focus', 'active'] as const;
export type LinkPseudo = typeof LINK_PSEUDO_KEYS[number];

/** Element keys covered by the nav-menu desktop sub-scope. `ul` + `li`
 *  style the inline list/items; `aActive` styles the link of the
 *  currently-visited page (selector: `li.active a`). Order in the
 *  array is the storage order; render order is split so `ul`/`li`
 *  appear above the link sub-scope and `aActive` appears below it. */
export const NAV_MENU_DESKTOP_KEYS = ['ul', 'li', 'aActive'] as const;
export type NavMenuDesktopKey = typeof NAV_MENU_DESKTOP_KEYS[number];

/** Element keys covered by the bookmark-folder sub-scope. Narrow set:
 *  `item` (.profile-list-item row), `icon` (.profile-list-item__icon),
 *  `desc` (.profile-list-item__desc). Each section exposes ONE property
 *  only (see BOOKMARK_FOLDER_SCHEMAS below). */
export const BOOKMARK_FOLDER_KEYS = ['item', 'icon', 'desc'] as const;
export type BookmarkFolderKey = typeof BOOKMARK_FOLDER_KEYS[number];

/** Element keys covered by the articles-list sub-scope. Targets the
 *  `.nn-card`-based article tiles inside the rendered carousel:
 *  `card` (the card surface), `title` (the `<h3>` inside), `meta` (the
 *  author/date strip). Each section exposes ONE property only. */
export const ARTICLES_LIST_KEYS = ['card', 'title', 'meta'] as const;
export type ArticlesListKey = typeof ARTICLES_LIST_KEYS[number];

/** Block types that surface the link sub-scope in the Properties panel.
 *  These are the blocks whose rendered output can contain `<a>` elements
 *  (either directly via user content, or transitively via mounted lists,
 *  embeds, weblogs, articles, nav-menus). Other block types (image,
 *  gallery, video, audio, embed, divider) skip the sub-scope. */
export const BLOCKS_WITH_LINKS_SUBSCOPE = new Set<string>([
  'heading', 'text', 'quote', 'list', 'links', 'columns', 'div',
  'bookmark-folder', 'button-cta', 'dm-button', 'profile-card',
  'articles-list', 'weblog', 'nav-menu', 'vendor-footer',
]);

// ──────────────────────────────────────────────────────────────────────────
// Property entries (catalog payload shapes)
// ──────────────────────────────────────────────────────────────────────────

/** All catalog-addressable property keys (everything on `CommonStyle`
 *  except sub-scope containers `mobileMenu` / `links` / `navMenu`,
 *  which have their own recursive render paths; and `border`, the
 *  legacy shorthand kept on the type for read-side migration only —
 *  never surfaced as an editable entry). */
export type PropertyKey = Exclude<keyof CommonStyle, 'mobileMenu' | 'border' | 'links' | 'navMenu' | 'bookmarkFolder' | 'articlesList'>;

/** A "single" entry maps to one CSS declaration (e.g. `color: red`). */
export interface SinglePropertyEntry {
  kind: 'single';
  key:
    | 'color' | 'background' | 'fontSize' | 'lineHeight' | 'fontWeight'
    | 'fontStyle' | 'borderRadius' | 'width' | 'height' | 'gridGap';
  label: string;
  cssProp: string;
  placeholder: string;
}

/** A "quad" entry maps to four CSS declarations (e.g. `margin-top: 0px; …`)
 *  OR to a single shorthand declaration (`border-width: T R B L`) — the
 *  caller decides via `cssShorthand`. Defaults to per-side declarations
 *  when omitted, preserving the original margin/padding behaviour. */
export interface QuadPropertyEntry {
  kind: 'quad';
  key: 'margin' | 'padding' | 'borderWidth' | 'borderColor' | 'positionInsets';
  label: string;
  /** Used when `cssShorthand` is unset — emits `<cssPrefix>-<side>: <v>`
   *  per non-empty side. */
  cssPrefix?: string;
  /** Used when set — emits a single shorthand declaration in CSS order
   *  `<top> <right> <bottom> <left>`. Empty sides fall back to `0` so
   *  the shorthand always has 4 tokens. */
  cssShorthand?: string;
  /** Per-side input placeholder. Defaults to '0px' when omitted. */
  placeholder?: string;
}

/** A "dropdown" entry — single CSS value, picked from a fixed list of
 *  options via the project-wide `CustomDropdown` molecule. The renderer
 *  emits a slot the dropdown gets mounted into; NospressView wires the
 *  CustomDropdown instance after each render. */
export interface DropdownPropertyEntry {
  kind: 'dropdown';
  key: 'borderStyle' | 'display' | 'position' | 'textDecoration' | 'textAlign' | 'alignButton';
  label: string;
  cssProp: string;
  options: Array<{ value: string; label: string }>;
  /** When set, `buildInlineStyle` / `buildImportantInlineStyle` skip
   *  emitting this property even though it lives in the schema. Used by
   *  `alignButton` (dm-button) where the value drives a renderer-side
   *  wrapper, not an inline declaration on the block itself. */
  skipInlineEmit?: boolean;
}

/** A "divider" entry: top + bottom edge decorations rendered as absolute
 *  SVG children of the block wrapper (NOT a CSS declaration). */
export interface DividerPropertyEntry {
  kind: 'divider';
  key: 'divider';
  label: string;
}

/** A "text-shadow" entry: 3 numeric inputs (H / V / Blur) + a Color row
 *  with the same swatches popover as the regular Color/Background props.
 *  Composed into a single `text-shadow: <h> <v> <blur> <color>` CSS
 *  declaration at render time. */
export interface TextShadowPropertyEntry {
  kind: 'text-shadow';
  key: 'textShadow';
  label: string;
}

export type PropertyEntry = SinglePropertyEntry | QuadPropertyEntry | DividerPropertyEntry | TextShadowPropertyEntry | DropdownPropertyEntry;

/** Side identifiers used by quad properties (margin/padding/border-*).
 *  Exported so the build / breakpointCss modules iterate the same set. */
export const QUAD_SIDES = ['top', 'bottom', 'left', 'right'] as const;
export type QuadSide = typeof QUAD_SIDES[number];

// ──────────────────────────────────────────────────────────────────────────
// Property groups + matrix
// ──────────────────────────────────────────────────────────────────────────

export interface PropertyGroup {
  /** Stable id used for SCSS hooks / accordion state. */
  key: string;
  /** Section header shown in the property panel. */
  label: string;
  /** Catalog-key list — order within the group is the rendered row
   *  order, e.g. Typography always shows color first then fontSize.
   *  A nested array marks adjacent entries as one paired row: at wide
   *  panel widths they share a row (CSS-grid `auto-fit`), at narrow
   *  widths they collapse to one-per-row. Quads (margin / padding /
   *  border-width / border-color) can technically be paired but
   *  visually need full width — keep them single. */
  props: Array<PropertyKey | PropertyKey[]>;
}

/** Resolved group: a `PropertyGroup` with its `props` keys mapped through
 *  `PROPERTY_CATALOG` to ready-to-render entries. Nested arrays preserve
 *  the source's paired-row marker — renderer turns them into
 *  `.nospress-prop-pair` grid containers. Used by the panel renderer;
 *  build* functions stay on the flat `schemaFor` API. */
export interface ResolvedPropertyGroup {
  key: string;
  label: string;
  entries: Array<PropertyEntry | PropertyEntry[]>;
}

// ──────────────────────────────────────────────────────────────────────────
// Mobile-menu sub-scope sections (definitions; values live in catalog.ts)
// ──────────────────────────────────────────────────────────────────────────

export interface MobileMenuSectionDef {
  key: MobileMenuSection;
  label: string;
  groups: PropertyGroup[];
}
