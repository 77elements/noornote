/**
 * NosPress style system — shared CSS-property infrastructure used by the
 * Page wrapper and (in future slices) individual blocks.
 *
 * Architecture (matrix design):
 *
 *   PROPERTY_CATALOG    — single source of truth for every property:
 *                         the CSS mapping, the input kind (single / quad),
 *                         the label, the placeholder.
 *
 *   STYLE_MATRIX        — for each scope ('page', or a block type), lists
 *                         the property keys the user is allowed to set.
 *                         Adding a property to a new block type = ONE entry
 *                         in this matrix. Adding a brand-new property =
 *                         one entry in PROPERTY_CATALOG.
 *
 *   schemaFor(scope)    — resolves a scope to its PropertyEntry[] schema,
 *                         used by the renderer.
 *
 * Sanitizing happens centrally in `sanitizeStyleValue`. Anything written
 * into a `style="…"` HTML attribute MUST go through `buildInlineStyle`.
 */

import { escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { PALETTE_KEYS, type PaletteKey } from './siteSettings';

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface BoxValues {
  top?: string;
  bottom?: string;
  left?: string;
  right?: string;
}

/**
 * Common style payload — the same shape applies to the Page and to any
 * future block-level style. Strict superset is fine: blocks can only set
 * properties listed in their STYLE_MATRIX row, but the type here stays
 * unified so the helpers don't need to be parameterised.
 */
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

export interface CommonStyle {
  color?: string;
  background?: string;
  fontSize?: string;
  lineHeight?: string;
  fontWeight?: string;
  fontStyle?: string;
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
  /** CSS `text-decoration` (none / underline / overline / line-through).
   *  Applies to the block itself in regular Typography AND to any link
   *  sub-scope where overriding the underline is the most common case. */
  textDecoration?: string;
}

/** Selectors covered by the mobile-menu sub-scope. Order is the
 *  display order of the accordion sections in the property panel. */
export const MOBILE_MENU_SECTION_KEYS = ['ul', 'li', 'a', 'aActive', 'hamburger', 'overlay'] as const;
export type MobileMenuSection = typeof MOBILE_MENU_SECTION_KEYS[number];

/** Pseudo-class slots covered by the per-block link sub-scope. Order is
 *  the display order of the accordion sections in the property panel. */
export const LINK_PSEUDO_KEYS = ['link', 'visited', 'hover', 'focus', 'active'] as const;
export type LinkPseudo = typeof LINK_PSEUDO_KEYS[number];

/** Block types that surface the link sub-scope in the Properties panel.
 *  These are the blocks whose rendered output can contain `<a>` elements
 *  (either directly via user content, or transitively via mounted lists,
 *  embeds, weblogs, articles, nav-menus). Other block types (image,
 *  gallery, video, audio, embed, divider) skip the sub-scope. */
export const BLOCKS_WITH_LINKS_SUBSCOPE = new Set<string>([
  'heading', 'text', 'quote', 'list', 'links', 'columns', 'div',
  'bookmark-folder', 'button-cta', 'dm-button', 'profile-card',
  'articles-list', 'weblog', 'nav-menu',
]);

/** All catalog-addressable property keys (everything on `CommonStyle`
 *  except sub-scope containers `mobileMenu` / `links`, which have their
 *  own recursive render paths; and `border`, the legacy shorthand kept
 *  on the type for read-side migration only — never surfaced as an
 *  editable entry). */
export type PropertyKey = Exclude<keyof CommonStyle, 'mobileMenu' | 'border' | 'links'>;

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
  key: 'borderStyle' | 'display' | 'position' | 'textDecoration';
  label: string;
  cssProp: string;
  options: Array<{ value: string; label: string }>;
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

const QUAD_SIDES = ['top', 'bottom', 'left', 'right'] as const;
type QuadSide = typeof QUAD_SIDES[number];

// ──────────────────────────────────────────────────────────────────────────
// Catalog + Matrix
// ──────────────────────────────────────────────────────────────────────────

export const PROPERTY_CATALOG: Record<PropertyKey, PropertyEntry> = {
  color:        { kind: 'single', key: 'color',        label: 'Color',         cssProp: 'color',         placeholder: 'e.g. #ede2da' },
  background:   { kind: 'single', key: 'background',   label: 'Background',    cssProp: 'background',    placeholder: 'e.g. #0f0d23' },
  fontSize:     { kind: 'single', key: 'fontSize',     label: 'Font size',     cssProp: 'font-size',     placeholder: 'e.g. 1rem' },
  lineHeight:   { kind: 'single', key: 'lineHeight',   label: 'Line height',   cssProp: 'line-height',   placeholder: 'e.g. 1.5' },
  fontWeight:   { kind: 'single', key: 'fontWeight',   label: 'Font weight',   cssProp: 'font-weight',   placeholder: '400 | 600 | bold' },
  fontStyle:    { kind: 'single', key: 'fontStyle',    label: 'Font style',    cssProp: 'font-style',    placeholder: 'normal | italic' },
  // (Border-related catalog entries follow — and per-block default
  // `display` values are computed via `getDefaultDisplayFor` further down.)
  // Border split into 3 properties: width (quad), style (dropdown), color (quad).
  // All emit shorthand declarations so the rendered CSS stays compact.
  borderWidth:  { kind: 'quad',   key: 'borderWidth',  label: 'Border width',  cssShorthand: 'border-width', placeholder: 'e.g. 1px' },
  borderStyle:  {
    kind: 'dropdown', key: 'borderStyle', label: 'Border style', cssProp: 'border-style',
    options: [
      { value: '',       label: '(none)' },
      { value: 'solid',  label: 'Solid' },
      { value: 'dashed', label: 'Dashed' },
      { value: 'dotted', label: 'Dotted' },
      { value: 'double', label: 'Double' },
    ],
  },
  borderColor:  { kind: 'quad',   key: 'borderColor',  label: 'Border color',  cssShorthand: 'border-color', placeholder: 'e.g. var(--color-3)' },
  borderRadius: { kind: 'single', key: 'borderRadius', label: 'Border radius', cssProp: 'border-radius', placeholder: 'e.g. 8px' },
  width:        { kind: 'single', key: 'width',        label: 'Width',         cssProp: 'width',         placeholder: 'e.g. 100%, 800px, 60ch' },
  height:       { kind: 'single', key: 'height',       label: 'Height',        cssProp: 'height',        placeholder: 'e.g. 480px, 60vh, auto' },
  textDecoration: {
    kind: 'dropdown', key: 'textDecoration', label: 'Text decoration', cssProp: 'text-decoration',
    options: [
      { value: 'none',         label: 'none' },
      { value: 'underline',    label: 'underline' },
      { value: 'overline',     label: 'overline' },
      { value: 'line-through', label: 'line-through' },
    ],
  },
  display:      {
    kind: 'dropdown', key: 'display', label: 'Display', cssProp: 'display',
    options: [
      { value: 'block',         label: 'block' },
      { value: 'inline',        label: 'inline' },
      { value: 'inline-block',  label: 'inline-block' },
      { value: 'flex',          label: 'flex' },
      { value: 'inline-flex',   label: 'inline-flex' },
      { value: 'grid',          label: 'grid' },
      { value: 'inline-grid',   label: 'inline-grid' },
      { value: 'none',          label: 'none' },
    ],
  },
  gridGap:      { kind: 'single', key: 'gridGap',      label: 'Gap',           cssProp: 'gap',           placeholder: '0' },
  position:     {
    kind: 'dropdown', key: 'position', label: 'Position', cssProp: 'position',
    options: [
      { value: 'static',   label: 'static' },
      { value: 'relative', label: 'relative' },
      { value: 'absolute', label: 'absolute' },
      { value: 'fixed',    label: 'fixed' },
      { value: 'sticky',   label: 'sticky' },
    ],
  },
  // Per-side top/right/bottom/left offsets. Empty `cssPrefix` means the
  // emitted CSS props are the side names directly (`top: <v>`, etc.) —
  // not `<prefix>-<side>`. The renderer surfaces this entry only when
  // the current `position` value is `absolute` or `sticky`.
  positionInsets: { kind: 'quad', key: 'positionInsets', label: 'Offsets', cssPrefix: '', placeholder: 'e.g. 10px' },
  margin:       { kind: 'quad',   key: 'margin',       label: 'Margin',        cssPrefix: 'margin' },
  padding:      { kind: 'quad',   key: 'padding',      label: 'Padding',       cssPrefix: 'padding' },
  divider:      { kind: 'divider', key: 'divider',     label: 'Divider' },
  textShadow:   { kind: 'text-shadow', key: 'textShadow', label: 'Text shadow' },
};

/**
 * Property groups — the canonical CSS-concept partition. Each block scope
 * is a composition of these groups, rendered top-to-bottom in a fixed
 * canonical order (set in `groupedSchemaFor`). Adding a new property to
 * an existing group automatically propagates it to every block scope
 * that includes the group.
 *
 * Modularization rationale: the same group composition pattern carries
 * through to nested sub-scopes (mobile-menu's per-selector panels) where
 * one selector's "available styles" is just a group composition again.
 */
export interface PropertyGroup {
  /** Stable id used for SCSS hooks / accordion state. */
  key: string;
  /** Section header shown in the property panel. */
  label: string;
  /** Catalog-key list — order within the group is the rendered row
   *  order, e.g. Typography always shows color first then fontSize. */
  props: PropertyKey[];
}

const GROUP_POSITION:   PropertyGroup = { key: 'position',   label: 'Position',   props: ['position', 'positionInsets'] };
const GROUP_DISPLAY:    PropertyGroup = { key: 'display',    label: 'Layout',     props: ['display', 'gridGap'] };
const GROUP_SPACING:    PropertyGroup = { key: 'spacing',    label: 'Spacing',    props: ['margin', 'padding'] };
const GROUP_SIZING_FULL:PropertyGroup = { key: 'sizing',     label: 'Sizing',     props: ['width', 'height'] };
const GROUP_SIZING_W:   PropertyGroup = { key: 'sizing',     label: 'Sizing',     props: ['width'] };
const GROUP_TYPOGRAPHY: PropertyGroup = { key: 'typography', label: 'Typography', props: ['color', 'fontSize', 'lineHeight', 'fontWeight', 'fontStyle', 'textDecoration', 'textShadow'] };
const GROUP_BACKGROUND: PropertyGroup = { key: 'background', label: 'Background', props: ['background'] };
const GROUP_BORDER:     PropertyGroup = { key: 'border',     label: 'Border',     props: ['borderWidth', 'borderStyle', 'borderColor', 'borderRadius'] };
const GROUP_EFFECTS:    PropertyGroup = { key: 'effects',    label: 'Effects',    props: ['divider'] };

/** Composition shorthand for prose-flow blocks (heading/text/list/links/
 *  dm-button/quote/button-cta) — typography + width sizing, no height
 *  (forcing height on text content clips silently). */
const TEXTUAL_GROUPS: PropertyGroup[] = [GROUP_POSITION, GROUP_DISPLAY, GROUP_SPACING, GROUP_SIZING_W, GROUP_TYPOGRAPHY, GROUP_BACKGROUND, GROUP_BORDER];

/** Schema slice surfaced inside each link sub-scope section
 *  (Link/Visited/Hover/Focus/Active). No sizing — `<a>` elements are
 *  inline by default and sizing rarely makes sense. No effects/divider —
 *  same reasoning. */
export const LINK_SUBSCOPE_GROUPS: PropertyGroup[] = [
  GROUP_POSITION, GROUP_DISPLAY, GROUP_SPACING, GROUP_TYPOGRAPHY, GROUP_BACKGROUND, GROUP_BORDER,
];

/** Composition shorthand for media/sub-component containers — full
 *  sizing (width + height for hero bands, fixed-aspect boxes), no
 *  typography (text styling doesn't apply to image/video/etc.). */
const CONTAINER_GROUPS: PropertyGroup[] = [GROUP_POSITION, GROUP_DISPLAY, GROUP_SPACING, GROUP_SIZING_FULL, GROUP_BACKGROUND, GROUP_BORDER];

/**
 * Per-scope group composition. The scope key matches whatever comes
 * BEFORE the first `:` in the runtime scope string — so 'page' and
 * 'heading:<uuid>' both resolve via this map. Add new rows here when a
 * block type starts supporting style.
 *
 * Display order is the canonical group order: Spacing → Sizing →
 * Typography → Background → Border → Effects. Each scope's array is
 * already authored in that order so the renderer iterates as-is.
 */
export const STYLE_MATRIX: Record<string, PropertyGroup[]> = {
  // Page: everything except sizing — the page surface fills its host.
  page: [GROUP_POSITION, GROUP_DISPLAY, GROUP_SPACING, GROUP_TYPOGRAPHY, GROUP_BACKGROUND, GROUP_BORDER],
  heading:           TEXTUAL_GROUPS,
  text:              TEXTUAL_GROUPS,
  list:              TEXTUAL_GROUPS,
  links:             TEXTUAL_GROUPS,
  'dm-button':       TEXTUAL_GROUPS,
  // Divider block is restricted: only `color` from typography (no font
  // styling — there's no text to style), plus standard box edges.
  divider:           [
    GROUP_SPACING,
    { key: 'typography', label: 'Typography', props: ['color'] },
    GROUP_BORDER,
  ],
  image:             CONTAINER_GROUPS,
  gallery:           CONTAINER_GROUPS,
  embed:             CONTAINER_GROUPS,
  'bookmark-folder': CONTAINER_GROUPS,
  columns:           CONTAINER_GROUPS,
  'profile-card':    CONTAINER_GROUPS,
  quote:             TEXTUAL_GROUPS,
  'button-cta':      TEXTUAL_GROUPS,
  video:             CONTAINER_GROUPS,
  audio:             CONTAINER_GROUPS,
  'articles-list':   CONTAINER_GROUPS,
  weblog:            CONTAINER_GROUPS,
  // Nav-menu wrapper: like the textual blocks plus full sizing — the
  // menu container is positioned/sized like a media block.
  'nav-menu':        [GROUP_POSITION, GROUP_DISPLAY, GROUP_SPACING, GROUP_SIZING_FULL, GROUP_TYPOGRAPHY, GROUP_BACKGROUND, GROUP_BORDER],
  // Nav-menu mobile drawer sub-scope is rendered through a separate
  // section-aware path (`renderMobileMenuSubScope`), not via the flat
  // matrix here — the panel is per-selector accordion sections, each
  // containing the standard groups for that selector.
  // DIV (and its HTML-tag variants header/footer/main/section/article/
  // aside/nav/fieldset) is the most permissive container — full
  // typography (users do put headings + text inside), full sizing, plus
  // the divider edge-shapes that no other block scope supports.
  div:               [GROUP_POSITION, GROUP_DISPLAY, GROUP_SPACING, GROUP_SIZING_FULL, GROUP_TYPOGRAPHY, GROUP_BACKGROUND, GROUP_BORDER, GROUP_EFFECTS],
};

// ──────────────────────────────────────────────────────────────────────────
// Mobile-menu sub-scope sections
// ──────────────────────────────────────────────────────────────────────────

/** One section per drawer-DOM selector, each composed of the same
 *  property-group primitives that block scopes use. The mobile-menu
 *  property panel renders one accordion entry per section. */
export interface MobileMenuSectionDef {
  key: MobileMenuSection;
  label: string;
  groups: PropertyGroup[];
}

export const MOBILE_MENU_SECTIONS: MobileMenuSectionDef[] = [
  // Drawer panel — container styling. Full sizing (drawer width is
  // user-tuneable), spacing, background, border. No typography (children
  // inherit the regular page font).
  { key: 'ul',        label: 'Drawer (ul)',           groups: [GROUP_POSITION, GROUP_DISPLAY, GROUP_SPACING, GROUP_SIZING_FULL, GROUP_BACKGROUND, GROUP_BORDER] },
  // Item rows — list-item-level styling. Full set: spacing, sizing
  // (height for fixed-height rows), typography (per-item overrides),
  // background, border (separators).
  { key: 'li',        label: 'Items (li)',            groups: [GROUP_POSITION, GROUP_DISPLAY, GROUP_SPACING, GROUP_SIZING_FULL, GROUP_TYPOGRAPHY, GROUP_BACKGROUND, GROUP_BORDER] },
  // Links — text styling primary. Spacing for hit-area padding,
  // typography + background + border. No sizing (anchors are inline).
  { key: 'a',         label: 'Links (a)',             groups: [GROUP_POSITION, GROUP_DISPLAY, GROUP_SPACING, GROUP_TYPOGRAPHY, GROUP_BACKGROUND, GROUP_BORDER] },
  // Active link — same prop set as `a`, just targets `<li class="active">`.
  { key: 'aActive',   label: 'Active link (a.active)', groups: [GROUP_POSITION, GROUP_DISPLAY, GROUP_SPACING, GROUP_TYPOGRAPHY, GROUP_BACKGROUND, GROUP_BORDER] },
  // Hamburger button — color + sizing + spacing + box. No fontSize/etc
  // since it's an icon, but `color` (from typography) drives the SVG
  // currentColor stroke.
  { key: 'hamburger', label: 'Hamburger button',      groups: [GROUP_POSITION, GROUP_DISPLAY, GROUP_SPACING, GROUP_SIZING_FULL, GROUP_TYPOGRAPHY, GROUP_BACKGROUND, GROUP_BORDER] },
  // Backdrop — just a background colour / image.
  { key: 'overlay',   label: 'Backdrop overlay',      groups: [GROUP_BACKGROUND] },
];

/** Strip the disambiguator (e.g. block UUID) from a runtime scope. */
function matrixKey(scope: string): string {
  const colon = scope.indexOf(':');
  return colon < 0 ? scope : scope.slice(0, colon);
}

/** Natural CSS `display` value per block scope — used to pre-fill the
 *  Display dropdown so the user always sees what the element actually
 *  renders as before they pick an explicit override. */
export const BLOCK_DEFAULT_DISPLAY: Record<string, string> = {
  page:              'block',
  heading:           'block',
  text:              'block',
  list:              'block',
  links:             'block',
  divider:           'block',
  image:             'block',
  gallery:           'block',
  embed:             'block',
  'bookmark-folder': 'block',
  columns:           'grid',
  'profile-card':    'block',
  quote:             'block',
  'button-cta':      'inline-block',
  'dm-button':       'inline-block',
  video:             'block',
  audio:             'block',
  'articles-list':   'block',
  weblog:            'block',
  div:               'block',
  'nav-menu':        'block',
};

/** Same idea for the mobile-menu sub-scope, indexed by section selector
 *  (the section drives which DOM element the styles target). */
export const MOBILE_SECTION_DEFAULT_DISPLAY: Record<MobileMenuSection, string> = {
  ul:        'block',
  li:        'block',
  a:         'inline',
  aActive:   'inline',
  hamburger: 'inline-block',
  overlay:   'block',
};

/** Resolve the natural display value for a property-panel render. The
 *  scope tells us the block type; the field prefix tells us whether
 *  we're editing the wrapper (`''`) or a mobile-menu sub-section
 *  (`mobileMenu.<sec>.`). */
export function getDefaultDisplayFor(scope: string, fieldPrefix: string): string {
  if (fieldPrefix.startsWith('mobileMenu.')) {
    const sec = fieldPrefix.slice('mobileMenu.'.length).split('.')[0] as MobileMenuSection;
    return MOBILE_SECTION_DEFAULT_DISPLAY[sec] ?? '';
  }
  return BLOCK_DEFAULT_DISPLAY[matrixKey(scope)] ?? '';
}

/** Resolved group: a `PropertyGroup` with its `props` keys mapped through
 *  `PROPERTY_CATALOG` to ready-to-render entries. Used by the panel
 *  renderer; build* functions stay on the flat `schemaFor` API. */
export interface ResolvedPropertyGroup {
  key: string;
  label: string;
  entries: PropertyEntry[];
}

/** Resolve a runtime scope ('page', 'heading:<uuid>', …) to a flat
 *  schema list. Used by `buildInlineStyle` / `buildBlockBreakpointCss` /
 *  `buildImportantInlineStyle` — these don't care about grouping, only
 *  the per-property CSS mapping. */
export function schemaFor(scope: string): PropertyEntry[] {
  return groupedSchemaFor(scope).flatMap(g => g.entries);
}

/** Resolve a runtime scope to its grouped schema. Used by
 *  `renderPropertyPanel` to emit one section header + property rows
 *  per group. Returns groups in the canonical display order as defined
 *  in `STYLE_MATRIX[scope]`. */
export function groupedSchemaFor(scope: string): ResolvedPropertyGroup[] {
  const groups = STYLE_MATRIX[matrixKey(scope)] ?? [];
  return groups.map(g => ({
    key: g.key,
    label: g.label,
    entries: g.props.map(k => PROPERTY_CATALOG[k]),
  }));
}

// ──────────────────────────────────────────────────────────────────────────
// Sanitize / build / read / write
// ──────────────────────────────────────────────────────────────────────────

/**
 * Strip characters that could break out of `style="…"` or the CSS
 * declaration itself, plus a generous length cap. Surviving characters
 * cover normal CSS values: numbers, units, colours, var(), calc(),
 * gradients with multiple stops, etc.
 *
 * Additionally drop the value entirely if it contains a `url(...)` with
 * a dangerous scheme (javascript:, data:, vbscript:) — characters like
 * `:` are allowed for `var(--x)` and `calc()`, so the bracket-stripping
 * pass alone cannot block these. Browsers commonly refuse to execute
 * script-URLs inside `style="…"`, but CSP / browser-bug surface makes
 * defence-in-depth worthwhile.
 */
const MAX_STYLE_VALUE_LEN = 1000; // multi-stop gradients with var() refs add up
export function sanitizeStyleValue(raw: string): string {
  const stripped = raw.replace(/[;<>"'\\]/g, '').trim().slice(0, MAX_STYLE_VALUE_LEN);
  if (/url\s*\(\s*['"]?\s*(javascript|data|vbscript)\s*:/i.test(stripped)) return '';
  return stripped;
}

/**
 * Validate a CSS identifier (for `class` and `id` HTML attribute values).
 * Tokens must start with a letter and may contain letters, digits, hyphens
 * and underscores. Multi mode allows space-separated tokens (for `class`),
 * single mode rejects whitespace.
 *
 * Returns the cleaned value or empty string if no token survived.
 */
export function sanitizeCssIdent(raw: string, mode: 'single' | 'multi' = 'single'): string {
  const trimmed = raw.trim().slice(0, 80);
  if (!trimmed) return '';
  const tokenRe = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
  if (mode === 'single') {
    return tokenRe.test(trimmed) ? trimmed : '';
  }
  const tokens = trimmed.split(/\s+/).filter(t => tokenRe.test(t)).slice(0, 5);
  return tokens.join(' ');
}

/** Build the `style="…"` payload from a CommonStyle, restricted to schema. */
export function buildInlineStyle(schema: PropertyEntry[], styleIn: CommonStyle | undefined): string {
  if (!styleIn) return '';
  const style = migrateLegacyBorder(styleIn);
  const parts: string[] = [];
  const push = (prop: string, value: string | undefined) => {
    if (!value) return;
    const v = sanitizeStyleValue(value);
    if (v) parts.push(`${prop}: ${v}`);
  };
  for (const entry of schema) {
    if (entry.kind === 'single') {
      push(entry.cssProp, style[entry.key]);
    } else if (entry.kind === 'quad') {
      const box = style[entry.key];
      if (!box) continue;
      if (entry.cssShorthand) {
        const shorthand = composeQuadShorthand(box);
        if (shorthand) parts.push(`${entry.cssShorthand}: ${shorthand}`);
      } else if (entry.cssPrefix !== undefined) {
        // Empty prefix → side names ARE the CSS props (e.g. `top: 10px`
        // for `positionInsets`). Otherwise: `<prefix>-<side>`.
        for (const side of QUAD_SIDES) {
          const cssProp = entry.cssPrefix ? `${entry.cssPrefix}-${side}` : side;
          push(cssProp, box[side]);
        }
      }
    } else if (entry.kind === 'dropdown') {
      push(entry.cssProp, style[entry.key]);
    } else if (entry.kind === 'text-shadow') {
      const composed = composeTextShadow(style.textShadow);
      if (composed) push('text-shadow', composed);
    }
    // 'divider' is rendered as separate SVG children of the wrapper,
    // not as an inline style declaration.
  }
  return parts.join('; ');
}

/** Compose a CSS shorthand `<top> <right> <bottom> <left>` from a
 *  BoxValues. Empty sides collapse to `0` so the shorthand always
 *  carries 4 tokens; returns empty string when ALL sides are empty so
 *  callers can skip the declaration entirely. */
function composeQuadShorthand(box: BoxValues): string {
  const t = sanitizeStyleValue(box.top ?? '');
  const r = sanitizeStyleValue(box.right ?? '');
  const b = sanitizeStyleValue(box.bottom ?? '');
  const l = sanitizeStyleValue(box.left ?? '');
  if (!t && !r && !b && !l) return '';
  return `${t || '0'} ${r || '0'} ${b || '0'} ${l || '0'}`;
}

/** Parse a legacy CSS `border` shorthand into width/style/color. Used
 *  to migrate old data where `border?: string` was the single field on
 *  CommonStyle. Tolerant: any token can appear in any order; unknown
 *  tokens get swept into the colour bucket so multi-token colour
 *  values like `rgb(...)` survive (joined back with spaces). */
const BORDER_STYLE_TOKENS = new Set([
  'none', 'hidden', 'solid', 'dashed', 'dotted', 'double',
  'groove', 'ridge', 'inset', 'outset',
]);
function parseBorderShorthand(input: string): { width?: string; style?: string; color?: string } {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const out: { width?: string; style?: string; color?: string } = {};
  const colourTokens: string[] = [];
  for (const t of tokens) {
    if (BORDER_STYLE_TOKENS.has(t)) out.style = t;
    else if (/^[\d.]+(px|em|rem|%|vh|vw|pt|cm|mm|in|ch|ex)?$/i.test(t)) out.width = t;
    else colourTokens.push(t);
  }
  if (colourTokens.length) out.color = colourTokens.join(' ');
  return out;
}

/** Hydrate the new `borderWidth/borderStyle/borderColor` fields from the
 *  legacy `border` shorthand when the new ones are missing. Returns a
 *  shallow-merged COPY — never mutates the input. Build / read paths
 *  call this so old-data-only blocks keep rendering until the user
 *  touches a border input (which clears `style.border` on next write). */
function migrateLegacyBorder(style: CommonStyle): CommonStyle {
  if (!style.border) return style;
  if (style.borderWidth || style.borderStyle || style.borderColor) return style;
  const p = parseBorderShorthand(style.border);
  const fillBox = (v: string): BoxValues => ({ top: v, right: v, bottom: v, left: v });
  return {
    ...style,
    ...(p.width ? { borderWidth: fillBox(p.width) } : {}),
    ...(p.style ? { borderStyle: p.style } : {}),
    ...(p.color ? { borderColor: fillBox(p.color) } : {}),
  };
}

/** Compose `text-shadow` from its 4 sub-fields. Emits nothing when all
 *  sub-fields are empty; otherwise fills missing pieces with sensible
 *  defaults (`0` for offsets/blur, `black` for color). */
function composeTextShadow(ts: CommonStyle['textShadow']): string {
  if (!ts) return '';
  const h = (ts.h ?? '').trim();
  const v = (ts.v ?? '').trim();
  const blur = (ts.blur ?? '').trim();
  const color = (ts.color ?? '').trim();
  if (!h && !v && !blur && !color) return '';
  return `${h || '0'} ${v || '0'} ${blur || '0'} ${color || 'black'}`;
}

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
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Renderer
// ──────────────────────────────────────────────────────────────────────────

export interface RenderPropertyPanelOptions {
  /** Runtime scope. 'page' for the page itself, '<blockType>:<blockId>'
   *  for a block-level panel. Used as `data-style-scope` on every input
   *  so the input-delegation in NospressView can dispatch correctly. */
  scope: string;
  /** Active style values (used to populate input `value` attributes).
   *  When breakpoint tabs are active, this is the resolved slot for the
   *  currently-selected tab — caller does the slot-picking. */
  style: CommonStyle | undefined;
  /** Active HTML-attribute overrides (`class` / `id` on the block wrapper).
   *  Only meaningful for block scopes — the page wrapper is always
   *  `.user-site`, so this is ignored when scope === 'page'. */
  attrs?: { class?: string; id?: string } | undefined;
  /** Currently selected divider side in the Top/Bottom switch (only
   *  relevant when the schema includes the divider property). Default top. */
  activeDividerSide?: 'top' | 'bottom';
  /** Effective palette (user overrides + Deep Purple defaults) used to
   *  paint the inline color swatches with the user's actual colors,
   *  without pushing CSS variables onto the editor scope. The clicked
   *  swatch still records `var(--color-N)` so the public site tracks
   *  palette changes dynamically. */
  palette?: Partial<Record<PaletteKey, string>>;
  /** Breakpoint tabs row at the top of the panel. Empty / undefined
   *  array = no tabs rendered (single-style block). The first tab in
   *  the array is mobile-first / base; selecting it edits `block.style`.
   *  Subsequent tabs edit `block.breakpointStyles[<name>]`. */
  breakpointTabs?: Array<{ name: string; label: string }>;
  /** Currently active breakpoint tab name. Must match one of
   *  `breakpointTabs[i].name`. */
  activeBreakpoint?: string;
  /** Block-type-specific extra controls (e.g. nav-menu's Horizontal
   *  toggle). Rendered between the Identifiers section and the standard
   *  property rows. Caller is responsible for the inner HTML; tabs +
   *  base styling come from `.nn-checkbox` / `.form__row` etc. */
  extras?: string;
  /** Optional raw HTML to render in the panel header slot instead of the
   *  breakpoint tabs. Used by sub-scope panels (e.g. nav-menu's Mobile
   *  Menu) to show a single-line title where the tabs would normally be.
   *  When set, `breakpointTabs` is ignored. */
  header?: string;
}

interface DividerStyleDef {
  /** UI label shown in the picker. */
  name: string;
  /** Vertical extent of the cut. Per-style because a wave needs more
   *  headroom than a slant; user has no override (= keep config minimal). */
  height: string;
  /** Sample points along the cut edge in band coords, ordered LEFT→RIGHT.
   *  x ∈ [0, 100], y ∈ [0, 10] where y=0 is the inner peak (deepest into
   *  the wrapper) and y=10 is the wrapper's outer edge.
   *  First x must be 0, last x must be 100 — the cut spans the full width.
   *  Curves are pre-sampled to polygon points so we get a single uniform
   *  pipeline (CSS `clip-path: polygon()` doesn't take Bezier directly). */
  cutPath: Array<[number, number]>;
}

/** Sample n+1 evenly-spaced points along a quadratic Bezier. Used to
 *  approximate smooth curves as polygon points. */
function sampleQuad(p0: [number, number], cp: [number, number], p1: [number, number], n: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const x = u * u * p0[0] + 2 * t * u * cp[0] + t * t * p1[0];
    const y = u * u * p0[1] + 2 * t * u * cp[1] + t * t * p1[1];
    pts.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
  }
  return pts;
}

/** Catalog of available divider styles. Each entry is the cut shape; the
 *  renderer applies it as `clip-path` on the wrapper so the parent
 *  container's bottom (or top) edge is geometrically removed and whatever
 *  sits behind shows through. Adding a new shape = one entry here. */
export const DIVIDER_CATALOG: Record<Exclude<DividerStyle, 'none'>, DividerStyleDef> = {
  slant: {
    name: 'Slant',
    height: '60px',
    cutPath: [[0, 10], [100, 0]],
  },
  curve: {
    name: 'Curve',
    height: '80px',
    cutPath: sampleQuad([0, 10], [50, 0], [100, 10], 12),
  },
  'curve-asymmetric': {
    name: 'Curve Asymmetric',
    height: '80px',
    cutPath: sampleQuad([0, 10], [33, 0], [100, 10], 12),
  },
  triangle: {
    name: 'Triangle',
    height: '60px',
    cutPath: [[0, 10], [50, 0], [100, 10]],
  },
  'triangle-asymmetric': {
    name: 'Triangle Asymmetric',
    height: '60px',
    cutPath: [[0, 10], [33, 0], [100, 10]],
  },
  wave: {
    name: 'Wave',
    height: '80px',
    cutPath: [
      ...sampleQuad([0, 10], [25, 0], [50, 10], 6),
      ...sampleQuad([50, 10], [75, 0], [100, 10], 6).slice(1),
    ],
  },
  'wave-double': {
    name: 'Wave Double',
    height: '60px',
    cutPath: [
      ...sampleQuad([0, 10], [12.5, 0], [25, 10], 4),
      ...sampleQuad([25, 10], [37.5, 0], [50, 10], 4).slice(1),
      ...sampleQuad([50, 10], [62.5, 0], [75, 10], 4).slice(1),
      ...sampleQuad([75, 10], [87.5, 0], [100, 10], 4).slice(1),
    ],
  },
  mountains: {
    name: 'Mountains',
    height: '80px',
    cutPath: [[0, 10], [20, 4], [40, 7], [60, 2], [80, 6], [100, 10]],
  },
  notch: {
    name: 'Notch',
    height: '60px',
    // Rectangular indent in the middle — vertical edges at x=35 and x=65.
    cutPath: [[0, 10], [35, 10], [35, 0], [65, 0], [65, 10], [100, 10]],
  },
};

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

/** Flat schema for the link sub-scope — derived once from
 *  `LINK_SUBSCOPE_GROUPS` so `buildInlineStyle` /
 *  `buildImportantInlineStyle` can be called per-pseudo-class without
 *  re-resolving the group list every time. */
const LINK_SUBSCOPE_SCHEMA: PropertyEntry[] = LINK_SUBSCOPE_GROUPS
  .flatMap(g => g.props.map(k => PROPERTY_CATALOG[k]));

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

/** Same payload as `buildInlineStyle` but appends `!important` to every
 *  declaration so per-breakpoint overrides outrank the wrapper's inline
 *  base styles when their media query matches. */
export function buildImportantInlineStyle(schema: PropertyEntry[], styleIn: CommonStyle | undefined): string {
  if (!styleIn) return '';
  const style = migrateLegacyBorder(styleIn);
  const parts: string[] = [];
  const push = (prop: string, value: string | undefined) => {
    if (!value) return;
    const v = sanitizeStyleValue(value);
    if (v) parts.push(`${prop}: ${v} !important`);
  };
  for (const entry of schema) {
    if (entry.kind === 'single') {
      push(entry.cssProp, style[entry.key]);
    } else if (entry.kind === 'quad') {
      const box = style[entry.key];
      if (!box) continue;
      if (entry.cssShorthand) {
        const shorthand = composeQuadShorthand(box);
        if (shorthand) parts.push(`${entry.cssShorthand}: ${shorthand} !important`);
      } else if (entry.cssPrefix !== undefined) {
        for (const side of QUAD_SIDES) {
          const cssProp = entry.cssPrefix ? `${entry.cssPrefix}-${side}` : side;
          push(cssProp, box[side]);
        }
      }
    } else if (entry.kind === 'dropdown') {
      push(entry.cssProp, style[entry.key]);
    } else if (entry.kind === 'text-shadow') {
      const composed = composeTextShadow(style.textShadow);
      if (composed) push('text-shadow', composed);
    }
    // 'divider' (clip-path) is not yet supported per-breakpoint — single
    // property, lives on the base wrapper for now.
  }
  return parts.join('; ');
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
        const linksCss = buildBlockLinksCss(blockTyped, breakpoints);
        if (linksCss) out.push(linksCss);
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

/** Resolve a divider field (the value at `style.divider.<side>`) to a
 *  catalog key, tolerating the legacy `{ style, color, height }` shape. */
function resolveDividerStyle(value: unknown): Exclude<DividerStyle, 'none'> | null {
  let s: string | null = null;
  if (typeof value === 'string') s = value;
  else if (value && typeof value === 'object' && typeof (value as { style?: unknown }).style === 'string') {
    s = (value as { style: string }).style;
  }
  if (!s || s === 'none') return null;
  return s in DIVIDER_CATALOG ? (s as Exclude<DividerStyle, 'none'>) : null;
}

/** Build a CSS `clip-path: polygon(...)` string from the divider config.
 *  Returns null when no divider is configured. The polygon walks the
 *  wrapper's perimeter clockwise, perturbing the top edge with the top
 *  cut path (left→right) and the bottom edge with the bottom cut path
 *  (right→left). When only one side is set, the other side stays straight. */
/** Apply the user's flip flags to a cut path.
 *   - `flipY` (vertical = mirror at x-axis): y → 10−y. Order preserved.
 *   - `flipX` (horizontal = mirror at y-axis): x → 100−x + reverse so
 *     the result still walks left→right.
 *  Both can be combined; the operations commute. */
function transformCutPath(
  cutPath: Array<[number, number]>,
  flipX: boolean,
  flipY: boolean,
): Array<[number, number]> {
  let pts: Array<[number, number]> = cutPath;
  if (flipY) pts = pts.map(([x, y]) => [x, 10 - y]);
  if (flipX) pts = [...pts].reverse().map(([x, y]) => [100 - x, y]);
  return pts;
}

function buildClipPath(divider: CommonStyle['divider']): string | null {
  const topStyle = resolveDividerStyle(divider?.top);
  const bottomStyle = resolveDividerStyle(divider?.bottom);
  if (!topStyle && !bottomStyle) return null;
  const flipX = !!divider?.flipX;
  const flipY = !!divider?.flipY;

  const points: string[] = [];

  if (topStyle) {
    const def = DIVIDER_CATALOG[topStyle];
    const path = transformCutPath(def.cutPath, flipX, flipY);
    // For a TOP cut, band y=10 is the wrapper's outer top (y=0%) and y=0
    // is the inner peak (y = topHeight). Map: wrapY = topH * (10 - bandY) / 10
    for (const [x, y] of path) {
      points.push(`${x}% calc(${def.height} * ${((10 - y) / 10).toFixed(3)})`);
    }
  } else {
    points.push('0% 0%', '100% 0%');
  }

  if (bottomStyle) {
    const def = DIVIDER_CATALOG[bottomStyle];
    const path = transformCutPath(def.cutPath, flipX, flipY);
    // For a BOTTOM cut, band y=10 is the wrapper's outer bottom (y=100%)
    // and y=0 is the inner peak (y = 100% - bottomHeight).
    // Map: wrapY = calc(100% - bottomH * (10 - bandY) / 10)
    // Reverse the cut path so we walk right→left (CW perimeter).
    const reversed = [...path].reverse();
    for (const [x, y] of reversed) {
      points.push(`${x}% calc(100% - ${def.height} * ${((10 - y) / 10).toFixed(3)})`);
    }
  } else {
    points.push('100% 100%', '0% 100%');
  }

  return `polygon(${points.join(', ')})`;
}

/** UI-side metadata for the divider style picker — value + visible label.
 *  Derived from `DIVIDER_CATALOG` so adding a shape automatically adds it
 *  to the picker. `none` is hard-coded as the first option. */
export const DIVIDER_STYLE_OPTIONS: Array<{ value: DividerStyle; label: string }> = [
  { value: 'none', label: 'None' },
  ...(Object.entries(DIVIDER_CATALOG) as Array<[Exclude<DividerStyle, 'none'>, DividerStyleDef]>)
    .map(([value, def]) => ({ value: value as DividerStyle, label: def.name })),
];

/** Tiny inline SVG thumbnail for one divider style (or a flat line for
 *  'none'). Used in the dropdown trigger and in each menu option. Closes
 *  the cutPath back along the bottom edge to render the area-that-gets-cut
 *  as a filled polygon — matches the visual the user gets on the page. */
export function dividerThumbSvg(style: DividerStyle | string): string {
  if (style === 'none' || !DIVIDER_CATALOG[style as Exclude<DividerStyle, 'none'>]) {
    return `<svg viewBox="0 0 100 10" preserveAspectRatio="none"><line x1="0" y1="9" x2="100" y2="9" stroke="currentColor" stroke-width="1"/></svg>`;
  }
  const def = DIVIDER_CATALOG[style as Exclude<DividerStyle, 'none'>];
  const moves = def.cutPath
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`)
    .join(' ');
  // Close back along the band's bottom (y=10) to the first point.
  const last = def.cutPath[def.cutPath.length - 1]!;
  const path = `${moves} L${last[0]},10 L${def.cutPath[0]![0]},10 Z`;
  return `<svg viewBox="0 0 100 10" preserveAspectRatio="none"><path d="${path}" fill="currentColor"/></svg>`;
}

/** Render a property panel for a given scope. The schema is looked up via
 *  `schemaFor(scope)`. If the matrix has no row for the scope, an empty
 *  body is rendered (defensive — caller should have verified). */
// ──────────────────────────────────────────────────────────────────────────
// Block style wrapper
// ──────────────────────────────────────────────────────────────────────────

/**
 * Wrap rendered block HTML with a styled outer element. The wrapper is
 * always emitted (even when the block has no style yet) so the
 * `data-styled-block-id` hook is available for live-updates.
 *
 * Custom HTML attributes (`attrs.class`, `attrs.id`) come from the user's
 * Identifiers panel and are sanitized through `sanitizeCssIdent()` before
 * being merged into the wrapper. This is what lets `customCss` selectors
 * like `.my-block` or `#hero` target an individual block.
 *
 * `opts.tag` and `opts.baseClass` let self-wrapping renderers (e.g. the
 * Div block, whose chosen HTML tag IS the wrapper) call styleWrap with
 * their own outer element so we don't end up nesting `<div><header>…`.
 */
/** HTML void elements — emitted self-closing so `<hr ...>` doesn't end up
 *  with an invalid closing tag. The list is intentionally narrow; only
 *  the elements actually used as block roots are covered. */
const VOID_ELEMENTS = new Set(['hr', 'br', 'img', 'input']);

export function styleWrap(
  block: { id: string; type: string; style?: CommonStyle; attrs?: { class?: string; id?: string } },
  inner: string,
  opts: { tag?: string; baseClass?: string; extraAttrs?: string; extraInlineStyle?: string } = {},
): string {
  const tag = opts.tag ?? 'div';
  const baseClass = opts.baseClass ?? 'nospress-block-style';

  const inlineStyle = buildInlineStyle(schemaFor(block.type), block.style);

  // Divider is a clip-path on the wrapper itself — a true geometric cut so
  // whatever sits behind the block (the page body, the next section's bg,
  // a backdrop image, …) shows through without color guessing. Only the
  // div block (and its HTML-tag variants) supports divider via STYLE_MATRIX.
  const clipPath = buildClipPath(block.style?.divider);
  const pieces = [inlineStyle, clipPath ? `clip-path: ${clipPath}` : '', opts.extraInlineStyle ?? '']
    .filter(p => p && p.length > 0);
  const combinedStyle = pieces.join('; ');
  const styleAttr = combinedStyle ? ` style="${escapeHtmlAttr(combinedStyle)}"` : '';

  const customClass = sanitizeCssIdent(block.attrs?.class ?? '', 'multi');
  const classAttr = customClass ? ` nospress-block-style--custom ${escapeHtmlAttr(customClass)}` : '';

  const customId = sanitizeCssIdent(block.attrs?.id ?? '', 'single');
  const idAttr = customId ? ` id="${escapeHtmlAttr(customId)}"` : '';

  // Renderer-supplied data attributes (mount-slot markers like
  // `data-embed-mount`, lightbox container ids, etc.) get appended to
  // the opening tag verbatim — caller is responsible for escaping.
  const extraAttrs = opts.extraAttrs ? ` ${opts.extraAttrs}` : '';

  if (VOID_ELEMENTS.has(tag)) {
    return `<${tag} class="${baseClass}${classAttr}" data-styled-block-id="${block.id}"${idAttr}${styleAttr}${extraAttrs} />`;
  }
  return `<${tag} class="${baseClass}${classAttr}" data-styled-block-id="${block.id}"${idAttr}${styleAttr}${extraAttrs}>${inner}</${tag}>`;
}

/**
 * Substitute every `var(--color-N)` reference in a CSS value string with
 * the literal hex from the given palette. Used to paint editor-only
 * previews (color/background trigger, gradient band, stop handles, track)
 * with the user's actual colors — the editor scope deliberately keeps
 * `:root` defaults so chrome / tabs aren't tinted, so any preview that
 * needs the user's palette must resolve via this helper.
 *
 * The stored data model keeps `var(--color-N)` intact so the public site
 * tracks palette changes dynamically.
 */
export function resolvePaletteVars(css: string, palette: Partial<Record<PaletteKey, string>>): string {
  return css.replace(
    /var\s*\(\s*--(color-[1-6])\s*\)/g,
    (match, key) => palette[key as PaletteKey] ?? match,
  );
}

/**
 * Reusable palette-swatches row used by every "pick a color" UI in the
 * editor (block color/background props, divider color, gradient stop
 * color). Each swatch renders with the user's effective palette as a
 * literal hex fill (no `var(--color-N)` so the editor chrome / tabs are
 * untouched), and carries the supplied data-attribute so the consumer's
 * click handler can read which palette slot was picked.
 *
 * @param palette  effective palette (custom values + Deep Purple defaults).
 * @param dataAttrName  e.g. `palette-key` — final attr is `data-<name>`,
 *                      value is the slot id (`color-1` / `color-2` / …).
 * @param dataAttrValueFn  optional override for the attribute value, used
 *                      by gradient picker which records `var(--color-N)`
 *                      directly. Default: the slot id.
 */
export function renderPaletteSwatches(
  palette: Partial<Record<PaletteKey, string>>,
  dataAttrName: string,
  dataAttrValueFn: (k: PaletteKey) => string = (k) => k,
): string {
  return PALETTE_KEYS.map(k => {
    const fill = escapeHtmlAttr(palette[k] ?? '');
    const attrValue = escapeHtmlAttr(dataAttrValueFn(k));
    return `
      <button type="button"
              class="nospress-prop-color-swatch"
              data-${dataAttrName}="${attrValue}"
              style="background: ${fill}"
              aria-label="--${k}"></button>
    `;
  }).join('');
}

/**
 * Reusable color-picker row — full markup bundle for any "pick a color"
 * field in the editor: label + narrow text input + circular trigger
 * button + hidden inline swatches popover (palette + optional
 * gradient/custom swatches) + optional gradient-editor mount slot.
 *
 * Used by `renderPropertyPanel`'s color/background and text-shadow rows
 * today; designed to scale to the per-block mobile-menu sub-scope where
 * 5+ color rows live alongside each other.
 *
 * Click handling is centralized in `NospressView.handlePropColorClick`
 * which delegates by class — no per-instance wiring needed here.
 */
export function renderColorPickerRow(opts: {
  scope: string;
  /** Dotted-path field id, e.g. `color`, `background`, `textShadow.color`,
   *  `mobileBackground`. Used as `data-style-field` on the input AND as
   *  the `data-swatches-for` / `data-color-row-key` correlation key so
   *  the click handler maps trigger → popover unambiguously. */
  field: string;
  label: string;
  value: string;
  placeholder: string;
  palette: Partial<Record<PaletteKey, string>>;
  /** Adds the gradient-swatch trigger + the gradient-editor mount slot
   *  below the popover. Today only the wrapper Background row sets this. */
  includeGradient?: boolean;
}): string {
  const triggerBg = opts.value ? resolvePaletteVars(opts.value, opts.palette) : 'transparent';
  const paletteSwatches = renderPaletteSwatches(opts.palette, 'palette-key');
  const scopeAttr = escapeHtmlAttr(opts.scope);
  const fieldAttr = escapeHtmlAttr(opts.field);
  return `
    <div class="nospress-prop-row nospress-prop-row--color" data-color-row-key="${fieldAttr}">
      <label class="nospress-prop-row__label">${escapeHtmlAttr(opts.label)}</label>
      <input type="text" class="input nospress-prop-row__input nospress-prop-row__input--narrow"
             data-style-scope="${scopeAttr}" data-style-field="${fieldAttr}"
             value="${escapeHtmlAttr(opts.value)}" placeholder="${escapeHtmlAttr(opts.placeholder)}" />
      <span class="nospress-prop-color-picker" data-color-picker>
        <button type="button"
                class="nospress-prop-color-trigger"
                data-color-trigger
                style="background: ${escapeHtmlAttr(triggerBg)}"
                aria-label="Pick color"></button>
      </span>
    </div>
    <div class="nospress-prop-color-swatches-inline" hidden data-swatches-for="${fieldAttr}">
      ${paletteSwatches}
      ${opts.includeGradient ? `
        <button type="button"
                class="nospress-prop-color-swatch nospress-prop-color-swatch--gradient"
                data-open-gradient-editor
                aria-label="Gradient"></button>
      ` : ''}
      <label class="nospress-prop-color-swatch nospress-prop-color-swatch--custom" aria-label="Custom color">
        <input type="color" class="nospress-prop-color-native" />
      </label>
    </div>
    ${opts.includeGradient ? `
      <div class="nospress-prop-gradient-inline" hidden data-gradient-mount-for="${fieldAttr}"></div>
    ` : ''}
  `;
}

export function renderPropertyPanel(opts: RenderPropertyPanelOptions): string {
  // Mobile-menu sub-scope is rendered through a dedicated path that
  // splits the panel into per-selector accordion sections (ul/li/a/...).
  // It still goes through the same panel chrome (header / identifiers
  // are skipped by the sub-scope caller), so the branch happens here.
  if (opts.scope.startsWith('nav-menu-mobile')) {
    return renderMobileMenuSubScopePanel(opts);
  }
  return renderPanelInternal(opts, groupedSchemaFor(opts.scope), '');
}

/** Render just the per-group body markup (no panel chrome). Pure
 *  function over (opts, groups, fieldPrefix) — used by both the
 *  regular panel and the mobile-menu sub-scope's accordion sections.
 *  The prefix lets sub-scope sections write to nested paths
 *  (`mobileMenu.<sec>.<prop>`) without each entry-render function
 *  having to know about sub-scope semantics. */
function renderEntriesForGroups(
  opts: RenderPropertyPanelOptions,
  groups: ResolvedPropertyGroup[],
  fieldPrefix: string,
): string {
  const scopeAttr = escapeHtmlAttr(opts.scope);
  const v = (subPath: string): string => escapeHtmlAttr(readStyleField(opts.style, fieldPrefix + subPath) ?? '');
  const palette = opts.palette ?? {};

  const single = (e: SinglePropertyEntry) => {
    if (e.cssProp === 'color' || e.cssProp === 'background') return colorRow(e);
    return `
      <div class="nospress-prop-row">
        <label class="nospress-prop-row__label">${escapeHtmlAttr(e.label)}</label>
        <input type="text" class="input nospress-prop-row__input"
               data-style-scope="${scopeAttr}" data-style-field="${fieldPrefix}${e.key}"
               value="${v(e.key)}" placeholder="${escapeHtmlAttr(e.placeholder)}" />
      </div>
    `;
  };

  /** Color/Background row delegates to the shared helper. Background
   *  gets the gradient swatch + gradient-editor mount slot; plain Color
   *  doesn't (gradient is a fill concept, not a foreground concept). */
  const colorRow = (e: SinglePropertyEntry) => renderColorPickerRow({
    scope: opts.scope,
    field: fieldPrefix + e.key,
    label: e.label,
    value: v(e.key),
    placeholder: e.placeholder,
    palette,
    includeGradient: e.cssProp === 'background',
  });

  const quad = (e: QuadPropertyEntry) => {
    const ph = escapeHtmlAttr(e.placeholder ?? '0px');
    return `
      <div class="nospress-prop-row">
        <label class="nospress-prop-row__label">${escapeHtmlAttr(e.label)}</label>
        <div class="nospress-prop-quad">
          ${QUAD_SIDES.map(side => `
            <div class="nospress-prop-quad__cell">
              <input type="text" class="input nospress-prop-quad__input"
                     data-style-scope="${scopeAttr}" data-style-field="${fieldPrefix}${e.key}.${side}"
                     value="${v(`${e.key}.${side}`)}" placeholder="${ph}" />
              <span class="nospress-prop-quad__caption">${side.charAt(0).toUpperCase()}${side.slice(1)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  };

  /** Dropdown row — emits a slot div that NospressView's
   *  `mountStyleDropdowns` fills with a `CustomDropdown` instance. */
  const dropdown = (e: DropdownPropertyEntry) => {
    // Pre-fill: stored value wins, else a per-key fallback. `display`
    // uses the block's natural CSS default; `position` defaults to
    // `relative` everywhere (rather than the CSS-spec `static`) so
    // descendant absolute children resolve against the block by
    // default. `borderStyle` has its own `(none)` first option, no
    // fallback needed.
    const stored = v(e.key);
    const fallback = e.key === 'display' ? getDefaultDisplayFor(opts.scope, fieldPrefix)
      : e.key === 'position' ? 'relative'
      : '';
    const current = stored || fallback;
    return `
      <div class="nospress-prop-row">
        <label class="nospress-prop-row__label">${escapeHtmlAttr(e.label)}</label>
        <div class="nospress-prop-row__input"
             data-style-dropdown
             data-style-scope="${scopeAttr}"
             data-style-field="${fieldPrefix}${e.key}"
             data-current-value="${escapeHtmlAttr(current)}"
             data-options="${escapeHtmlAttr(JSON.stringify(e.options))}"></div>
      </div>
    `;
  };

  /** Render the Top/Bottom switch + the edit area for the currently
   *  active side. Active side is controlled by the caller (`opts.activeDividerSide`)
   *  so it persists across re-renders driven by other property changes.
   *  The picked value targets `divider.<side>` directly — no per-side
   *  Color or Height (fill is always `var(--color-1)`, height comes from
   *  the catalog entry). Effect-only.
   *
   *  Below the picker, a single global `flipX` checkbox mirrors every
   *  divider on this block horizontally. Same checkbox state is shown on
   *  Top and Bottom — toggling once flips both. */
  const dividerSide = (side: 'top' | 'bottom') => {
    const styleVal = v(`divider.${side}`) || 'none';
    const styleField = `${fieldPrefix}divider.${side}`;
    // Use the prefix-aware reader so per-sub-scope divider state (currently
    // unused — no mobile-menu section includes the divider entry) would
    // resolve correctly if it ever gets surfaced.
    const flipXChecked = (v('divider.flipX') === '1');
    const flipYChecked = (v('divider.flipY') === '1');

    const styleOptionsHtml = DIVIDER_STYLE_OPTIONS.map(opt => `
      <button type="button"
              class="nospress-divider-picker__option ${opt.value === styleVal ? 'is-selected' : ''}"
              data-divider-style-pick="${opt.value}"
              data-style-scope="${scopeAttr}"
              data-style-field="${styleField}"
              aria-label="${escapeHtmlAttr(opt.label)}">
        <span class="nospress-divider-picker__option-thumb">${dividerThumbSvg(opt.value)}</span>
        <span class="nospress-divider-picker__option-label">${escapeHtmlAttr(opt.label)}</span>
      </button>
    `).join('');

    const selectedOpt = DIVIDER_STYLE_OPTIONS.find(o => o.value === styleVal) ?? DIVIDER_STYLE_OPTIONS[0]!;

    return `
      <div class="nospress-prop-row">
        <label class="nospress-prop-row__label">Style</label>
        <div class="nospress-divider-picker" data-divider-picker>
          <button type="button" class="nospress-divider-picker__trigger" data-divider-picker-toggle aria-haspopup="listbox">
            <span class="nospress-divider-picker__trigger-thumb">${dividerThumbSvg(styleVal)}</span>
            <span class="nospress-divider-picker__trigger-label">${escapeHtmlAttr(selectedOpt.label)}</span>
          </button>
          <div class="nospress-divider-picker__menu" data-divider-picker-menu hidden>
            ${styleOptionsHtml}
          </div>
        </div>
      </div>
      <label class="nn-checkbox nn-checkbox--label-left">
        <span>Flip horizontally</span>
        <input type="checkbox"
               data-style-scope="${scopeAttr}"
               data-style-field="${fieldPrefix}divider.flipX"
               ${flipXChecked ? 'checked' : ''} />
      </label>
      <label class="nn-checkbox nn-checkbox--label-left">
        <span>Flip vertically</span>
        <input type="checkbox"
               data-style-scope="${scopeAttr}"
               data-style-field="${fieldPrefix}divider.flipY"
               ${flipYChecked ? 'checked' : ''} />
      </label>
    `;
  };

  /** Render the Text-shadow group: 3 numeric inputs (H / V / Blur) on
   *  one row + a Color row matching the regular Color/Background swatches
   *  popover. The four sub-fields write to `textShadow.h|v|blur|color`
   *  via the standard `data-style-field` dispatch; `composeTextShadow`
   *  joins them into a single CSS declaration at render time.
   *
   *  No own header — the parent Typography group section header now
   *  scopes it. The compound's structure (3 numeric inputs + a color
   *  row) is self-evident enough without a sub-label. */
  const textShadow = (_e: TextShadowPropertyEntry) => `
    <div class="nospress-prop-row">
      <label class="nospress-prop-row__label">Text shadow H</label>
      <input type="text" class="input nospress-prop-row__input"
             data-style-scope="${scopeAttr}" data-style-field="${fieldPrefix}textShadow.h"
             value="${v('textShadow.h')}" placeholder="e.g. 2px" />
    </div>
    <div class="nospress-prop-row">
      <label class="nospress-prop-row__label">Text shadow V</label>
      <input type="text" class="input nospress-prop-row__input"
             data-style-scope="${scopeAttr}" data-style-field="${fieldPrefix}textShadow.v"
             value="${v('textShadow.v')}" placeholder="e.g. 2px" />
    </div>
    <div class="nospress-prop-row">
      <label class="nospress-prop-row__label">Text shadow blur</label>
      <input type="text" class="input nospress-prop-row__input"
             data-style-scope="${scopeAttr}" data-style-field="${fieldPrefix}textShadow.blur"
             value="${v('textShadow.blur')}" placeholder="e.g. 4px" />
    </div>
    ${renderColorPickerRow({
      scope: opts.scope,
      field: `${fieldPrefix}textShadow.color`,
      label: 'Text shadow color',
      value: v('textShadow.color'),
      placeholder: 'e.g. #000',
      palette,
    })}
  `;

  const divider = (_e: DividerPropertyEntry) => {
    const active = opts.activeDividerSide ?? 'top';
    return `
      <div class="nospress-prop-row">
        <label class="nospress-prop-row__label">Side</label>
        <div class="nospress-prop-divider__sideswitch" role="tablist">
          <button type="button" class="nospress-prop-divider__sideswitch-btn ${active === 'top' ? 'is-active' : ''}" data-divider-side-switch="top">Top</button>
          <button type="button" class="nospress-prop-divider__sideswitch-btn ${active === 'bottom' ? 'is-active' : ''}" data-divider-side-switch="bottom">Bottom</button>
        </div>
      </div>
      ${dividerSide(active)}
    `;
  };

  const renderEntry = (entry: PropertyEntry): string => {
    // Conditional: positionInsets only surfaces when the current
    // `position` value is `absolute` or `sticky` — otherwise the
    // four offset inputs would do nothing and just clutter the panel.
    if (entry.kind === 'quad' && entry.key === 'positionInsets') {
      // Match the panel's pre-fill default for `position` (see
      // `dropdown` closure above) so the conditional behaves the same
      // whether or not the user has explicitly picked a value.
      const pos = readStyleField(opts.style, fieldPrefix + 'position') || 'relative';
      if (pos !== 'absolute' && pos !== 'sticky') return '';
    }
    // Conditional: gridGap only surfaces when the effective `display` is
    // `grid` or `inline-grid` — otherwise `gap` is a no-op and the row
    // would just clutter the Layout group. Mirrors the display
    // dropdown's pre-fill default so the conditional kicks in even when
    // the user hasn't explicitly set `display`.
    if (entry.kind === 'single' && entry.key === 'gridGap') {
      const display = readStyleField(opts.style, fieldPrefix + 'display')
        || getDefaultDisplayFor(opts.scope, fieldPrefix);
      if (display !== 'grid' && display !== 'inline-grid') return '';
    }
    return entry.kind === 'single' ? single(entry)
      : entry.kind === 'quad' ? quad(entry)
      : entry.kind === 'dropdown' ? dropdown(entry)
      : entry.kind === 'text-shadow' ? textShadow(entry)
      : divider(entry);
  };

  // Group sections — one section per resolved group, containing all of
  // its entries in declaration order. Section header is a plain `<h3
  // class="h4">` so it inherits the project's heading typography +
  // standard `margin-bottom: $gap` (see _typography.scss). Section
  // wrapper keeps a `data-group-key` for accordion-state hooks
  // downstream (mobile-menu sub-scope).
  return groups.map(g => `
    <section class="nospress-prop-group" data-group-key="${escapeHtmlAttr(g.key)}">
      <h3 class="h4">${escapeHtmlAttr(g.label)}</h3>
      ${g.entries.map(renderEntry).join('')}
    </section>
  `).join('');
}

/** Wrap a body in the standard panel chrome: header (tabs OR caller-
 *  provided header), identifiers, extras, body. Both the regular and
 *  the mobile-menu sub-scope paths terminate here. */
function renderPanelInternal(
  opts: RenderPropertyPanelOptions,
  groups: ResolvedPropertyGroup[],
  fieldPrefix: string,
): string {
  const scopeAttr = escapeHtmlAttr(opts.scope);
  const mainBody = renderEntriesForGroups(opts, groups, fieldPrefix);
  // Link sub-scope: 5 accordion sections (link/visited/hover/focus/active)
  // appended to the panel body for any block whose rendered output can
  // contain `<a>` elements. Same `nn-ui-toggle` accordion molecule as the
  // mobile-menu sub-scope so the existing toggle handler in NospressView
  // works without changes. Empty for non-block scopes (`page`) and for
  // sub-scope panels (handled separately above) and for sub-scope fields
  // already (no nested links inside links).
  const blockType = matrixKey(opts.scope);
  const showLinks = !fieldPrefix
    && BLOCKS_WITH_LINKS_SUBSCOPE.has(blockType);
  const linksBody = showLinks ? renderLinkSubScopeSections(opts) : '';
  const body = mainBody + linksBody;

  // Identifiers section — only for block scopes. The page itself doesn't get
  // a configurable class/id (its wrapper is always `.user-site`).
  const identifiersHtml = opts.scope === 'page' ? '' : `
    <div class="nospress-prop-row">
      <label class="nospress-prop-row__label">CSS Class</label>
      <input type="text" class="input nospress-prop-row__input"
             data-attr-scope="${scopeAttr}" data-attr-field="class"
             value="${escapeHtmlAttr(opts.attrs?.class ?? '')}" placeholder="e.g. hero featured" />
    </div>
    <div class="nospress-prop-row">
      <label class="nospress-prop-row__label">CSS ID</label>
      <input type="text" class="input nospress-prop-row__input"
             data-attr-scope="${scopeAttr}" data-attr-field="id"
             value="${escapeHtmlAttr(opts.attrs?.id ?? '')}" placeholder="e.g. main-cta" />
    </div>
  `;

  // Header slot: caller-provided raw HTML wins (used by sub-scope panels
  // to show a title in place of the tabs); otherwise breakpoint tabs are
  // rendered when defined; otherwise nothing.
  const tabs = opts.breakpointTabs ?? [];
  const activeBp = opts.activeBreakpoint ?? '';
  const headerHtml = opts.header ?? (tabs.length > 0
    ? `
      <div class="tabs nospress-block-properties__tabs">
        ${tabs.map(t => `
          <button type="button"
                  class="tab${t.name === activeBp ? ' tab--active' : ''}"
                  data-bp-tab="${escapeHtmlAttr(t.name)}">
            <span class="tab__label">${escapeHtmlAttr(t.label)}</span>
          </button>
        `).join('')}
      </div>
    `
    : '');

  return `
    <div class="nospress-block-properties" data-properties-for="${scopeAttr}">
      ${headerHtml}
      <div class="nospress-block-properties__body">
        ${identifiersHtml}
        ${opts.extras ?? ''}
        ${body}
      </div>
    </div>
  `;
}

/** Mobile-menu sub-scope panel — one accordion section per drawer
 *  selector, each containing the standard property groups for that
 *  selector (defined in `MOBILE_MENU_SECTIONS`). Inputs write to the
 *  nested `mobileMenu.<sec>.<prop>` slot via the `fieldPrefix` mechanism
 *  in `renderPanelInternal`.
 *
 *  Reuses `nn-ui-toggle` for the accordion (same molecule the Global
 *  tab uses), with `data-toggle-section` / `data-toggle-header` so the
 *  existing click handler in NospressView toggles the `.open` class. */
function renderMobileMenuSubScopePanel(opts: RenderPropertyPanelOptions): string {
  const scopeAttr = escapeHtmlAttr(opts.scope);
  const sectionsHtml = MOBILE_MENU_SECTIONS.map((sec, idx) => {
    // First section (Drawer / ul) starts open; the rest collapsed.
    const open = idx === 0 ? ' open' : '';
    // Resolve this section's groups against the catalog so the body
    // renderer gets ready-to-emit `PropertyEntry` instances.
    const resolvedGroups: ResolvedPropertyGroup[] = sec.groups.map(g => ({
      key: g.key,
      label: g.label,
      entries: g.props.map(k => PROPERTY_CATALOG[k]),
    }));
    // Emit just the body markup (groups + their entries) for this
    // section, bypassing the panel chrome — that's owned by the outer
    // wrapper below.
    const sectionBody = renderEntriesForGroups(opts, resolvedGroups, `mobileMenu.${sec.key}.`);
    return `
      <section class="nn-ui-toggle nospress-prop-mobile-section${open}" data-toggle-section data-mobile-section="${sec.key}">
        <div class="nn-ui-toggle__header" data-toggle-header>
          <div class="nn-ui-toggle__info">
            <h2 class="nn-ui-toggle__title">${escapeHtmlAttr(sec.label)}</h2>
          </div>
          <button class="nn-ui-toggle__toggle" aria-label="Toggle section">
            <svg width="16" height="16"><use href="#icon-chevron-down"/></svg>
          </button>
        </div>
        <div class="nn-ui-toggle__content">
          ${sectionBody}
        </div>
      </section>
    `;
  }).join('');

  return `
    <div class="nospress-block-properties" data-properties-for="${scopeAttr}">
      ${opts.header ?? ''}
      <div class="nospress-block-properties__body">
        ${sectionsHtml}
      </div>
    </div>
  `;
}

/** Per-block link sub-scope panel — 5 accordion sections, one per
 *  pseudo-class, appended below the main block properties for blocks
 *  in `BLOCKS_WITH_LINKS_SUBSCOPE`. Reuses `LINK_SUBSCOPE_GROUPS` (no
 *  sizing — `<a>` is inline by default). Inputs write to nested
 *  `links.<pseudo>.<prop>` slots via the `fieldPrefix` mechanism. */
const LINK_PSEUDO_LABELS: Record<LinkPseudo, string> = {
  link:    'Link (a:link)',
  visited: 'Visited (a:visited)',
  hover:   'Hover (a:hover)',
  focus:   'Focus (a:focus)',
  active:  'Active (a:active)',
};

function renderLinkSubScopeSections(opts: RenderPropertyPanelOptions): string {
  const resolvedGroups: ResolvedPropertyGroup[] = LINK_SUBSCOPE_GROUPS.map(g => ({
    key: g.key,
    label: g.label,
    entries: g.props.map(k => PROPERTY_CATALOG[k]),
  }));
  return LINK_PSEUDO_KEYS.map(pseudo => {
    // All collapsed by default — rare-use sub-scope, don't crowd the
    // panel on every block selection.
    const sectionBody = renderEntriesForGroups(opts, resolvedGroups, `links.${pseudo}.`);
    return `
      <section class="nn-ui-toggle nospress-prop-link-section" data-toggle-section data-link-pseudo="${pseudo}">
        <div class="nn-ui-toggle__header" data-toggle-header>
          <div class="nn-ui-toggle__info">
            <h2 class="nn-ui-toggle__title">${escapeHtmlAttr(LINK_PSEUDO_LABELS[pseudo])}</h2>
          </div>
          <button class="nn-ui-toggle__toggle" aria-label="Toggle section">
            <svg width="16" height="16"><use href="#icon-chevron-down"/></svg>
          </button>
        </div>
        <div class="nn-ui-toggle__content">
          ${sectionBody}
        </div>
      </section>
    `;
  }).join('');
}

