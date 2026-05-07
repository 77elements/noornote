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
import { PALETTE_KEYS } from './siteSettings';

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
/** Decorative divider shape rendered as an absolutely-positioned SVG at
 *  the top or bottom edge of a block. Available shapes intentionally kept
 *  to the simplest set — Divi-style elaborate (waves/clouds/mountains)
 *  shapes are out of scope. */
export type DividerStyle = 'none' | 'slant' | 'curve' | 'triangle';

export interface DividerConfig {
  style?: DividerStyle;
  color?: string;
  /** CSS length (e.g. `60px`, `4rem`). Default applied at render time. */
  height?: string;
}

export interface CommonStyle {
  color?: string;
  background?: string;
  fontSize?: string;
  lineHeight?: string;
  fontWeight?: string;
  fontStyle?: string;
  border?: string;
  borderRadius?: string;
  margin?: BoxValues;
  padding?: BoxValues;
  /** Top / bottom edge dividers — available only on the `div` block scope
   *  (and its HTML-tag variants header/footer/main/section/nav etc.). */
  divider?: { top?: DividerConfig; bottom?: DividerConfig };
}

export type PropertyKey = keyof CommonStyle;

/** A "single" entry maps to one CSS declaration (e.g. `color: red`). */
export interface SinglePropertyEntry {
  kind: 'single';
  key: 'color' | 'background' | 'fontSize' | 'lineHeight' | 'fontWeight' | 'fontStyle' | 'border' | 'borderRadius';
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

export type PropertyEntry = SinglePropertyEntry | QuadPropertyEntry | DividerPropertyEntry;

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
  margin:       { kind: 'quad',   key: 'margin',       label: 'Margin',        cssPrefix: 'margin' },
  padding:      { kind: 'quad',   key: 'padding',      label: 'Padding',       cssPrefix: 'padding' },
  divider:      { kind: 'divider', key: 'divider',     label: 'Divider' },
};

/**
 * Matrix of allowed properties per scope. The scope key matches whatever
 * comes BEFORE the first `:` in the runtime scope string — so 'page' and
 * 'heading:<uuid>' both resolve via this map. Add new rows here when a
 * block type starts supporting style.
 */
/**
 * Common text-block properties: applies to anything where the user types
 * prose (heading, text, list, links, dm-button). Shared for consistency
 * so a future Property addition propagates everywhere automatically.
 */
const TEXTUAL_PROPS: PropertyKey[] = [
  'color', 'background', 'lineHeight', 'fontWeight', 'fontStyle',
  'margin', 'padding', 'border', 'borderRadius',
];

/**
 * Container-only properties: blocks whose content is a media element or a
 * mounted sub-component, where text styling does not apply.
 */
const CONTAINER_PROPS: PropertyKey[] = [
  'background', 'margin', 'padding', 'border', 'borderRadius',
];

export const STYLE_MATRIX: Record<string, PropertyKey[]> = {
  // Page keeps its full set (incl. fontSize) — the global page surface
  // controls site-wide typography defaults.
  page: ['color', 'background', 'fontSize', 'lineHeight', 'fontWeight', 'fontStyle',
         'margin', 'padding', 'border', 'borderRadius'],
  heading:           TEXTUAL_PROPS,
  text:              TEXTUAL_PROPS,
  list:              TEXTUAL_PROPS,
  links:             TEXTUAL_PROPS,
  'dm-button':       TEXTUAL_PROPS,
  divider:           ['color', 'margin', 'padding', 'border', 'borderRadius'],
  image:             CONTAINER_PROPS,
  gallery:           CONTAINER_PROPS,
  embed:             CONTAINER_PROPS,
  'bookmark-folder': CONTAINER_PROPS,
  columns:           CONTAINER_PROPS,
  'profile-card':    CONTAINER_PROPS,
  quote:             TEXTUAL_PROPS,
  'button-cta':      TEXTUAL_PROPS,
  video:             CONTAINER_PROPS,
  audio:             CONTAINER_PROPS,
  'articles-list':   CONTAINER_PROPS,
  weblog:            CONTAINER_PROPS,
  // DIV (and its HTML-tag variants header/footer/main/section/article/aside/nav/fieldset)
  // is the container block — only it gets the divider property in addition
  // to the textual props.
  div:               [...TEXTUAL_PROPS, 'divider'],
};

/** Strip the disambiguator (e.g. block UUID) from a runtime scope. */
function matrixKey(scope: string): string {
  const colon = scope.indexOf(':');
  return colon < 0 ? scope : scope.slice(0, colon);
}

/** Resolve a runtime scope ('page', 'heading:<uuid>', …) to its schema. */
export function schemaFor(scope: string): PropertyEntry[] {
  const keys = STYLE_MATRIX[matrixKey(scope)] ?? [];
  return keys.map(k => PROPERTY_CATALOG[k]);
}

// ──────────────────────────────────────────────────────────────────────────
// Sanitize / build / read / write
// ──────────────────────────────────────────────────────────────────────────

/**
 * Strip characters that could break out of `style="…"` or the CSS
 * declaration itself, plus a length cap. Surviving characters cover
 * normal CSS values: numbers, units, colours, var(), spaces, etc.
 *
 * Additionally drop the value entirely if it contains a `url(...)` with
 * a dangerous scheme (javascript:, data:, vbscript:) — characters like
 * `:` are allowed for `var(--x)` and `calc()`, so the bracket-stripping
 * pass alone cannot block these. Browsers commonly refuse to execute
 * script-URLs inside `style="…"`, but CSP / browser-bug surface makes
 * defence-in-depth worthwhile.
 */
export function sanitizeStyleValue(raw: string): string {
  const stripped = raw.replace(/[;<>"'\\]/g, '').trim().slice(0, 100);
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
    }
    // 'divider' is rendered as separate SVG children of the wrapper,
    // not as an inline style declaration.
  }
  return parts.join('; ');
}

/** Read a dotted path: `color`, `margin.top`, or `divider.top.style`. */
export function readStyleField(style: CommonStyle | undefined, path: string): string | undefined {
  if (!style) return undefined;
  const segments = path.split('.');
  if (segments.length === 1) {
    const v = style[segments[0] as PropertyKey];
    return typeof v === 'string' ? v : undefined;
  }
  if (segments.length === 2) {
    const [head, side] = segments as [PropertyKey, QuadSide];
    const group = style[head];
    if (!group || typeof group === 'string') return undefined;
    return (group as Record<string, string | undefined>)[side];
  }
  if (segments.length === 3 && segments[0] === 'divider') {
    const side = segments[1] as 'top' | 'bottom';
    const field = segments[2] as keyof DividerConfig;
    const cfg = style.divider?.[side];
    return cfg?.[field];
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
    if (head === 'color' || head === 'background' || head === 'fontSize' || head === 'lineHeight') {
      if (trimmed) style[head] = trimmed;
      else delete style[head];
    }
    return;
  }
  if (segments.length === 2) {
    const head = segments[0];
    const side = segments[1] as QuadSide;
    if (head !== 'margin' && head !== 'padding') return;
    if (side !== 'top' && side !== 'bottom' && side !== 'left' && side !== 'right') return;
    if (!style[head]) style[head] = {};
    if (trimmed) style[head]![side] = trimmed;
    else delete style[head]![side];
    return;
  }
  if (segments.length === 3 && segments[0] === 'divider') {
    const side = segments[1] as 'top' | 'bottom';
    const field = segments[2] as keyof DividerConfig;
    if (side !== 'top' && side !== 'bottom') return;
    if (field !== 'style' && field !== 'color' && field !== 'height') return;
    if (!style.divider) style.divider = {};
    if (!style.divider[side]) style.divider[side] = {};
    if (trimmed) {
      (style.divider[side] as DividerConfig)[field] = trimmed as DividerStyle;
    } else {
      delete (style.divider[side] as DividerConfig)[field];
    }
    // Prune empty objects so `hasV2Content` reports the slot as unused.
    if (Object.keys(style.divider[side] as DividerConfig).length === 0) delete style.divider[side];
    if (Object.keys(style.divider).length === 0) delete style.divider;
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
  /** Active style values (used to populate input `value` attributes). */
  style: CommonStyle | undefined;
  /** Active HTML-attribute overrides (`class` / `id` on the block wrapper).
   *  Only meaningful for block scopes — the page wrapper is always
   *  `.user-site`, so this is ignored when scope === 'page'. */
  attrs?: { class?: string; id?: string } | undefined;
  /** Header label. Default 'Properties'. */
  header?: string;
  /** Currently selected divider side in the Top/Bottom switch (only
   *  relevant when the schema includes the divider property). Default top. */
  activeDividerSide?: 'top' | 'bottom';
}

/** UI-side metadata for the divider style picker — value + visible label. */
export const DIVIDER_STYLE_OPTIONS: Array<{ value: DividerStyle; label: string }> = [
  { value: 'none',     label: 'None' },
  { value: 'slant',    label: 'Slant' },
  { value: 'curve',    label: 'Curve' },
  { value: 'triangle', label: 'Triangle' },
];

/** Tiny inline SVG thumbnail for one divider style (or a flat line for
 *  'none'). Used in the dropdown trigger and in each menu option. */
export function dividerThumbSvg(style: DividerStyle | string): string {
  if (style === 'none' || !DIVIDER_PATHS[style as Exclude<DividerStyle, 'none'>]) {
    return `<svg viewBox="0 0 100 10" preserveAspectRatio="none"><line x1="0" y1="9" x2="100" y2="9" stroke="currentColor" stroke-width="1"/></svg>`;
  }
  const path = DIVIDER_PATHS[style as Exclude<DividerStyle, 'none'>];
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
export function styleWrap(
  block: { id: string; type: string; style?: CommonStyle; attrs?: { class?: string; id?: string } },
  inner: string,
  opts: { tag?: string; baseClass?: string } = {},
): string {
  const tag = opts.tag ?? 'div';
  const baseClass = opts.baseClass ?? 'nospress-block-style';

  const inlineStyle = buildInlineStyle(schemaFor(block.type), block.style);
  const styleAttr = inlineStyle ? ` style="${escapeHtmlAttr(inlineStyle)}"` : '';

  const customClass = sanitizeCssIdent(block.attrs?.class ?? '', 'multi');
  const classAttr = customClass ? ` nospress-block-style--custom ${escapeHtmlAttr(customClass)}` : '';

  const customId = sanitizeCssIdent(block.attrs?.id ?? '', 'single');
  const idAttr = customId ? ` id="${escapeHtmlAttr(customId)}"` : '';

  // Divider markup is emitted as SVG children of the wrapper. Only the
  // div block (and its HTML-tag variants) supports it via STYLE_MATRIX.
  const dividers = renderDividers(block.style?.divider);

  return `<${tag} class="${baseClass}${classAttr}" data-styled-block-id="${block.id}"${idAttr}${styleAttr}>${dividers.top}${inner}${dividers.bottom}</${tag}>`;
}

/** Render top/bottom divider SVGs from a `CommonStyle.divider` config.
 *  Returns empty strings for unset / 'none' slots so the wrapper output
 *  stays clean when the user hasn't configured anything. */
function renderDividers(divider: CommonStyle['divider']): { top: string; bottom: string } {
  return {
    top: renderDividerSvg(divider?.top, 'top'),
    bottom: renderDividerSvg(divider?.bottom, 'bottom'),
  };
}

function renderDividerSvg(cfg: DividerConfig | undefined, side: 'top' | 'bottom'): string {
  if (!cfg || !cfg.style || cfg.style === 'none') return '';
  const path = DIVIDER_PATHS[cfg.style];
  if (!path) return '';
  // Default fill is the page background colour (`var(--color-1)`) so the
  // divider visually "cuts" into the block, revealing the page bg behind
  // it — the typical Divi-style sloped-edge look. The user can override
  // with any colour for a decorative band instead of a cut.
  const fill = cfg.color ? sanitizeStyleValue(cfg.color) : 'var(--color-1)';
  const heightVar = `--nospress-divider-height: ${escapeHtmlAttr(sanitizeStyleValue(cfg.height ?? '60px'))}`;
  return `<div class="nospress-divider nospress-divider--${side}" style="${heightVar}" aria-hidden="true"><svg viewBox="0 0 100 10" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><path d="${path}" fill="${escapeHtmlAttr(fill)}"/></svg></div>`;
}

/** Simple SVG paths for the divider shapes. viewBox is `0 0 100 10` so each
 *  shape is a thin band that scales to the container's height via CSS. */
const DIVIDER_PATHS: Record<Exclude<DividerStyle, 'none'>, string> = {
  // Diagonal slope from bottom-left up to top-right, filled below.
  slant:    'M0,10 L100,0 L100,10 Z',
  // Symmetric bow, filled below.
  curve:    'M0,10 Q50,0 100,10 Z',
  // Centered downward triangle.
  triangle: 'M0,10 L50,0 L100,10 Z',
};

export function renderPropertyPanel(opts: RenderPropertyPanelOptions): string {
  const schema = schemaFor(opts.scope);
  const scopeAttr = escapeHtmlAttr(opts.scope);
  const v = (path: string): string => escapeHtmlAttr(readStyleField(opts.style, path) ?? '');

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

  /** Color/Background row: narrower text input + circular trigger button.
   *  Trigger opens a popover with the 6 palette swatches (resolve to
   *  `var(--color-X)`) and one custom-color swatch (opens native picker). */
  const colorRow = (e: SinglePropertyEntry) => {
    const value = v(e.key);
    const triggerBg = value || 'transparent';
    const paletteSwatches = PALETTE_KEYS.map(k => `
      <button type="button"
              class="nospress-prop-color-swatch"
              data-palette-key="${k}"
              style="background: var(--${k})"
              aria-label="--${k}"></button>
    `).join('');
    return `
      <div class="nospress-prop-row nospress-prop-row--color" data-color-row-key="${e.key}">
        <label class="nospress-prop-row__label">${escapeHtmlAttr(e.label)}</label>
        <input type="text" class="input nospress-prop-row__input nospress-prop-row__input--narrow"
               data-style-scope="${scopeAttr}" data-style-field="${e.key}"
               value="${value}" placeholder="${escapeHtmlAttr(e.placeholder)}" />
        <span class="nospress-prop-color-picker">
          <button type="button"
                  class="nospress-prop-color-trigger"
                  style="background: ${escapeHtmlAttr(triggerBg)}"
                  aria-label="Pick color"></button>
        </span>
      </div>
      <div class="nospress-prop-color-swatches-inline" hidden data-swatches-for="${e.key}">
        ${paletteSwatches}
        ${e.key === 'background' ? `
          <button type="button"
                  class="nospress-prop-color-swatch nospress-prop-color-swatch--gradient"
                  data-open-gradient-editor
                  aria-label="Gradient"></button>
        ` : ''}
        <label class="nospress-prop-color-swatch nospress-prop-color-swatch--custom" aria-label="Custom color">
          <input type="color" class="nospress-prop-color-native" />
        </label>
      </div>
      ${e.key === 'background' ? `
        <div class="nospress-prop-gradient-inline" hidden data-gradient-mount-for="${e.key}"></div>
      ` : ''}
    `;
  };

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
   *  Inputs target `divider.<side>.<field>` so writeStyleField persists into
   *  the right slot. */
  const dividerSide = (side: 'top' | 'bottom') => {
    const styleVal = v(`divider.${side}.style`) || 'none';
    const colorVal = v(`divider.${side}.color`);
    const heightVal = v(`divider.${side}.height`);
    const triggerBg = colorVal || 'transparent';
    const paletteSwatches = PALETTE_KEYS.map(k => `
      <button type="button"
              class="nospress-prop-color-swatch"
              data-palette-key="${k}"
              style="background: var(--${k})"
              aria-label="--${k}"></button>
    `).join('');
    const colorKey = `divider.${side}.color`;

    const styleOptionsHtml = DIVIDER_STYLE_OPTIONS.map(opt => `
      <button type="button"
              class="nospress-divider-picker__option ${opt.value === styleVal ? 'is-selected' : ''}"
              data-divider-style-pick="${opt.value}"
              data-style-scope="${scopeAttr}"
              data-style-field="divider.${side}.style"
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
      <div class="nospress-prop-row nospress-prop-row--color" data-color-row-key="${escapeHtmlAttr(colorKey)}">
        <label class="nospress-prop-row__label">Color</label>
        <input type="text" class="input nospress-prop-row__input nospress-prop-row__input--narrow"
               data-style-scope="${scopeAttr}" data-style-field="${colorKey}"
               value="${escapeHtmlAttr(colorVal)}" placeholder="e.g. #0f0d23" />
        <span class="nospress-prop-color-picker">
          <button type="button"
                  class="nospress-prop-color-trigger"
                  style="background: ${escapeHtmlAttr(triggerBg)}"
                  aria-label="Pick color"></button>
        </span>
      </div>
      <div class="nospress-prop-color-swatches-inline" hidden data-swatches-for="${escapeHtmlAttr(colorKey)}">
        ${paletteSwatches}
        <button type="button" class="nospress-prop-color-swatch nospress-prop-color-swatch--custom" aria-label="Custom color">
          <input type="color" class="nospress-prop-color-native" />
        </button>
      </div>
      <div class="nospress-prop-row">
        <label class="nospress-prop-row__label">Height</label>
        <input type="text" class="input nospress-prop-row__input"
               data-style-scope="${scopeAttr}" data-style-field="divider.${side}.height"
               value="${escapeHtmlAttr(heightVal)}" placeholder="60px" />
      </div>
    `;
  };

  const divider = (_e: DividerPropertyEntry) => {
    const active = opts.activeDividerSide ?? 'top';
    return `
      <div class="nospress-prop-grouplabel">Divider</div>
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

  const body = schema.map(entry =>
    entry.kind === 'single' ? single(entry)
      : entry.kind === 'quad' ? quad(entry)
      : divider(entry)
  ).join('');

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

  return `
    <div class="nospress-block-properties" data-properties-for="${scopeAttr}">
      <div class="nospress-block-properties__header">
        <span class="nospress-block-properties__label">${escapeHtmlAttr(opts.header ?? 'Properties')}</span>
      </div>
      <div class="nospress-block-properties__body">
        ${identifiersHtml}
        ${body}
      </div>
    </div>
  `;
}
