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
  border?: string;
  borderRadius?: string;
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
  /** Nav-menu mobile drawer styling. Lives on the same per-breakpoint
   *  slot as the rest of the wrapper styles, but only the nav-menu block
   *  surfaces these (via the `nav-menu-mobile` matrix entry — opened
   *  through the hamburger trigger button on the block itself). */
  mobileBackground?: string;
  mobileColor?: string;
  mobileActiveColor?: string;
  mobileFontSize?: string;
  hamburgerColor?: string;
  overlayBackground?: string;
}

export type PropertyKey = keyof CommonStyle;

/** A "single" entry maps to one CSS declaration (e.g. `color: red`). */
export interface SinglePropertyEntry {
  kind: 'single';
  key:
    | 'color' | 'background' | 'fontSize' | 'lineHeight' | 'fontWeight'
    | 'fontStyle' | 'border' | 'borderRadius' | 'width' | 'height'
    // Nav-menu mobile sub-scope keys.
    | 'mobileBackground' | 'mobileColor' | 'mobileActiveColor'
    | 'mobileFontSize' | 'hamburgerColor' | 'overlayBackground';
  label: string;
  cssProp: string;
  placeholder: string;
}

/** A "quad" entry maps to four CSS declarations (e.g. `margin-top: 0px; …`). */
export interface QuadPropertyEntry {
  kind: 'quad';
  key: 'margin' | 'padding';
  label: string;
  cssPrefix: string;
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

export type PropertyEntry = SinglePropertyEntry | QuadPropertyEntry | DividerPropertyEntry | TextShadowPropertyEntry;

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
  border:       { kind: 'single', key: 'border',       label: 'Border',        cssProp: 'border',        placeholder: '1px solid #252343' },
  borderRadius: { kind: 'single', key: 'borderRadius', label: 'Border radius', cssProp: 'border-radius', placeholder: 'e.g. 8px' },
  width:        { kind: 'single', key: 'width',        label: 'Width',         cssProp: 'width',         placeholder: 'e.g. 100%, 800px, 60ch' },
  height:       { kind: 'single', key: 'height',       label: 'Height',        cssProp: 'height',        placeholder: 'e.g. 480px, 60vh, auto' },
  margin:       { kind: 'quad',   key: 'margin',       label: 'Margin',        cssPrefix: 'margin' },
  padding:      { kind: 'quad',   key: 'padding',      label: 'Padding',       cssPrefix: 'padding' },
  divider:      { kind: 'divider', key: 'divider',     label: 'Divider' },
  textShadow:   { kind: 'text-shadow', key: 'textShadow', label: 'Text shadow' },
  // Nav-menu mobile drawer — surfaced only via `STYLE_MATRIX['nav-menu-mobile']`,
  // which is opened by the hamburger trigger button on the block.
  mobileBackground:  { kind: 'single', key: 'mobileBackground',  label: 'Drawer background',  cssProp: 'background', placeholder: 'e.g. #0f0d23' },
  mobileColor:       { kind: 'single', key: 'mobileColor',       label: 'Link color',         cssProp: 'color',      placeholder: 'e.g. #ede2da' },
  mobileActiveColor: { kind: 'single', key: 'mobileActiveColor', label: 'Active link color',  cssProp: 'color',      placeholder: 'e.g. #dc85ad' },
  mobileFontSize:    { kind: 'single', key: 'mobileFontSize',    label: 'Link font size',     cssProp: 'font-size',  placeholder: 'e.g. 1.25rem' },
  hamburgerColor:    { kind: 'single', key: 'hamburgerColor',    label: 'Hamburger color',    cssProp: 'color',      placeholder: 'e.g. #ede2da' },
  overlayBackground: { kind: 'single', key: 'overlayBackground', label: 'Backdrop',           cssProp: 'background', placeholder: 'rgba(0,0,0,0.5)' },
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

const GROUP_SPACING:    PropertyGroup = { key: 'spacing',    label: 'Spacing',    props: ['margin', 'padding'] };
const GROUP_SIZING_FULL:PropertyGroup = { key: 'sizing',     label: 'Sizing',     props: ['width', 'height'] };
const GROUP_SIZING_W:   PropertyGroup = { key: 'sizing',     label: 'Sizing',     props: ['width'] };
const GROUP_TYPOGRAPHY: PropertyGroup = { key: 'typography', label: 'Typography', props: ['color', 'fontSize', 'lineHeight', 'fontWeight', 'fontStyle', 'textShadow'] };
const GROUP_BACKGROUND: PropertyGroup = { key: 'background', label: 'Background', props: ['background'] };
const GROUP_BORDER:     PropertyGroup = { key: 'border',     label: 'Border',     props: ['border', 'borderRadius'] };
const GROUP_EFFECTS:    PropertyGroup = { key: 'effects',    label: 'Effects',    props: ['divider'] };

/** Composition shorthand for prose-flow blocks (heading/text/list/links/
 *  dm-button/quote/button-cta) — typography + width sizing, no height
 *  (forcing height on text content clips silently). */
const TEXTUAL_GROUPS: PropertyGroup[] = [GROUP_SPACING, GROUP_SIZING_W, GROUP_TYPOGRAPHY, GROUP_BACKGROUND, GROUP_BORDER];

/** Composition shorthand for media/sub-component containers — full
 *  sizing (width + height for hero bands, fixed-aspect boxes), no
 *  typography (text styling doesn't apply to image/video/etc.). */
const CONTAINER_GROUPS: PropertyGroup[] = [GROUP_SPACING, GROUP_SIZING_FULL, GROUP_BACKGROUND, GROUP_BORDER];

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
  page: [GROUP_SPACING, GROUP_TYPOGRAPHY, GROUP_BACKGROUND, GROUP_BORDER],
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
  'nav-menu':        [GROUP_SPACING, GROUP_SIZING_FULL, GROUP_TYPOGRAPHY, GROUP_BACKGROUND, GROUP_BORDER],
  // Nav-menu mobile drawer sub-scope — opened by the hamburger trigger
  // button on the block. Single-section list of mobile-* keys today;
  // will split into per-selector accordion sections (ul/li/a/...) in
  // a follow-up step.
  'nav-menu-mobile': [
    {
      key: 'mobile',
      label: 'Mobile drawer',
      props: ['mobileBackground', 'overlayBackground',
              'mobileColor', 'mobileActiveColor', 'mobileFontSize',
              'hamburgerColor'],
    },
  ],
  // DIV (and its HTML-tag variants header/footer/main/section/article/
  // aside/nav/fieldset) is the most permissive container — full
  // typography (users do put headings + text inside), full sizing, plus
  // the divider edge-shapes that no other block scope supports.
  div:               [GROUP_SPACING, GROUP_SIZING_FULL, GROUP_TYPOGRAPHY, GROUP_BACKGROUND, GROUP_BORDER, GROUP_EFFECTS],
};

/** Strip the disambiguator (e.g. block UUID) from a runtime scope. */
function matrixKey(scope: string): string {
  const colon = scope.indexOf(':');
  return colon < 0 ? scope : scope.slice(0, colon);
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
export function buildInlineStyle(schema: PropertyEntry[], style: CommonStyle | undefined): string {
  if (!style) return '';
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
      for (const side of QUAD_SIDES) push(`${entry.cssPrefix}-${side}`, box[side]);
    } else if (entry.kind === 'text-shadow') {
      const composed = composeTextShadow(style.textShadow);
      if (composed) push('text-shadow', composed);
    }
    // 'divider' is rendered as separate SVG children of the wrapper,
    // not as an inline style declaration.
  }
  return parts.join('; ');
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
export function readStyleField(style: CommonStyle | undefined, path: string): string | undefined {
  if (!style) return undefined;
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
  const segments = path.split('.');
  if (segments.length === 1) {
    const head = segments[0] as PropertyKey;
    // Single-string properties go straight onto the style record. The
    // catalog tells us which keys are `kind: 'single'` — anything else
    // (margin/padding quad, divider object) needs the multi-segment
    // branches below.
    const entry = PROPERTY_CATALOG[head];
    if (entry?.kind === 'single') {
      if (trimmed) (style as Record<string, string>)[head] = trimmed;
      else delete (style as Record<string, unknown>)[head];
    }
    return;
  }
  if (segments.length === 2) {
    const head = segments[0];
    if (head === 'margin' || head === 'padding') {
      const side = segments[1] as QuadSide;
      if (side !== 'top' && side !== 'bottom' && side !== 'left' && side !== 'right') return;
      if (!style[head]) style[head] = {};
      if (trimmed) style[head]![side] = trimmed;
      else delete style[head]![side];
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
function buildImportantInlineStyle(schema: PropertyEntry[], style: CommonStyle | undefined): string {
  if (!style) return '';
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
      for (const side of QUAD_SIDES) push(`${entry.cssPrefix}-${side}`, box[side]);
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
  if (breakpoints.length === 0) return '';
  const out: string[] = [];
  const walk = (list: Array<{ id?: string; type?: string; breakpointStyles?: Record<string, CommonStyle> } & Record<string, unknown>>) => {
    for (const b of list) {
      if (b.type && b.id) {
        const css = buildBlockBreakpointCss(b as { id: string; type: string; breakpointStyles?: Record<string, CommonStyle> }, breakpoints);
        if (css) out.push(css);
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
  opts: { tag?: string; baseClass?: string; extraAttrs?: string } = {},
): string {
  const tag = opts.tag ?? 'div';
  const baseClass = opts.baseClass ?? 'nospress-block-style';

  const inlineStyle = buildInlineStyle(schemaFor(block.type), block.style);

  // Divider is a clip-path on the wrapper itself — a true geometric cut so
  // whatever sits behind the block (the page body, the next section's bg,
  // a backdrop image, …) shows through without color guessing. Only the
  // div block (and its HTML-tag variants) supports divider via STYLE_MATRIX.
  const clipPath = buildClipPath(block.style?.divider);
  const combinedStyle = clipPath
    ? (inlineStyle ? `${inlineStyle}; clip-path: ${clipPath}` : `clip-path: ${clipPath}`)
    : inlineStyle;
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
      <span class="nospress-prop-color-picker">
        <button type="button"
                class="nospress-prop-color-trigger"
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
  const groups = groupedSchemaFor(opts.scope);
  const scopeAttr = escapeHtmlAttr(opts.scope);
  const v = (path: string): string => escapeHtmlAttr(readStyleField(opts.style, path) ?? '');
  const palette = opts.palette ?? {};

  const single = (e: SinglePropertyEntry) => {
    if (e.key === 'color' || e.key === 'background') return colorRow(e);
    return `
      <div class="nospress-prop-row">
        <label class="nospress-prop-row__label">${escapeHtmlAttr(e.label)}</label>
        <input type="text" class="input nospress-prop-row__input"
               data-style-scope="${scopeAttr}" data-style-field="${e.key}"
               value="${v(e.key)}" placeholder="${escapeHtmlAttr(e.placeholder)}" />
      </div>
    `;
  };

  /** Color/Background row delegates to the shared helper. Background
   *  gets the gradient swatch + gradient-editor mount slot; plain Color
   *  doesn't (gradient is a fill concept, not a foreground concept). */
  const colorRow = (e: SinglePropertyEntry) => renderColorPickerRow({
    scope: opts.scope,
    field: e.key,
    label: e.label,
    value: v(e.key),
    placeholder: e.placeholder,
    palette,
    includeGradient: e.cssProp === 'background',
  });

  const quad = (e: QuadPropertyEntry) => `
    <div class="nospress-prop-row">
      <label class="nospress-prop-row__label">${escapeHtmlAttr(e.label)}</label>
      <div class="nospress-prop-quad">
        ${QUAD_SIDES.map(side => `
          <div class="nospress-prop-quad__cell">
            <input type="text" class="input nospress-prop-quad__input"
                   data-style-scope="${scopeAttr}" data-style-field="${e.key}.${side}"
                   value="${v(`${e.key}.${side}`)}" placeholder="0px" />
            <span class="nospress-prop-quad__caption">${side.charAt(0).toUpperCase()}${side.slice(1)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;

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
    const styleField = `divider.${side}`;
    const flipXChecked = !!opts.style?.divider?.flipX;
    const flipYChecked = !!opts.style?.divider?.flipY;

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
          <div class="nospress-divider-picker__menu" hidden>
            ${styleOptionsHtml}
          </div>
        </div>
      </div>
      <label class="nn-checkbox nn-checkbox--label-left">
        <span>Flip horizontally</span>
        <input type="checkbox"
               data-style-scope="${scopeAttr}"
               data-style-field="divider.flipX"
               ${flipXChecked ? 'checked' : ''} />
      </label>
      <label class="nn-checkbox nn-checkbox--label-left">
        <span>Flip vertically</span>
        <input type="checkbox"
               data-style-scope="${scopeAttr}"
               data-style-field="divider.flipY"
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
             data-style-scope="${scopeAttr}" data-style-field="textShadow.h"
             value="${v('textShadow.h')}" placeholder="e.g. 2px" />
    </div>
    <div class="nospress-prop-row">
      <label class="nospress-prop-row__label">Text shadow V</label>
      <input type="text" class="input nospress-prop-row__input"
             data-style-scope="${scopeAttr}" data-style-field="textShadow.v"
             value="${v('textShadow.v')}" placeholder="e.g. 2px" />
    </div>
    <div class="nospress-prop-row">
      <label class="nospress-prop-row__label">Text shadow blur</label>
      <input type="text" class="input nospress-prop-row__input"
             data-style-scope="${scopeAttr}" data-style-field="textShadow.blur"
             value="${v('textShadow.blur')}" placeholder="e.g. 4px" />
    </div>
    ${renderColorPickerRow({
      scope: opts.scope,
      field: 'textShadow.color',
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

  const renderEntry = (entry: PropertyEntry): string =>
    entry.kind === 'single' ? single(entry)
      : entry.kind === 'quad' ? quad(entry)
      : entry.kind === 'text-shadow' ? textShadow(entry)
      : divider(entry);

  // Group sections — one section per resolved group, containing all of
  // its entries in declaration order. Section header is a plain `<h3
  // class="h4">` so it inherits the project's heading typography +
  // standard `margin-bottom: $gap` (see _typography.scss). Section
  // wrapper keeps a `data-group-key` for accordion-state hooks
  // downstream (mobile-menu sub-scope).
  const body = groups.map(g => `
    <section class="nospress-prop-group" data-group-key="${escapeHtmlAttr(g.key)}">
      <h3 class="h4">${escapeHtmlAttr(g.label)}</h3>
      ${g.entries.map(renderEntry).join('')}
    </section>
  `).join('');

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
