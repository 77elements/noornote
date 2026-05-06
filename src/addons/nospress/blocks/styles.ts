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

export type PropertyEntry = SinglePropertyEntry | QuadPropertyEntry;

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
  div:               TEXTUAL_PROPS,
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
 */
export function sanitizeStyleValue(raw: string): string {
  return raw.replace(/[;<>"'\\]/g, '').trim().slice(0, 100);
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
    } else {
      const box = style[entry.key];
      if (!box) continue;
      for (const side of QUAD_SIDES) push(`${entry.cssPrefix}-${side}`, box[side]);
    }
  }
  return parts.join('; ');
}

/** Read a dotted path: 'color' or 'margin.top'. */
export function readStyleField(style: CommonStyle | undefined, path: string): string | undefined {
  if (!style) return undefined;
  const dot = path.indexOf('.');
  if (dot < 0) {
    const v = style[path as PropertyKey];
    return typeof v === 'string' ? v : undefined;
  }
  const head = path.slice(0, dot) as PropertyKey;
  const side = path.slice(dot + 1) as QuadSide;
  const group = style[head];
  if (!group || typeof group === 'string') return undefined;
  return group[side];
}

/**
 * Write a dotted path. Empty / whitespace value deletes the field.
 * Mutates `style` in place. Caller is responsible for ensuring `style`
 * is an object (not undefined) — typically by initialising at the
 * mutation site.
 */
export function writeStyleField(style: CommonStyle, path: string, rawValue: string): void {
  const trimmed = rawValue.trim();
  const dot = path.indexOf('.');
  if (dot < 0) {
    if (path === 'color' || path === 'background' || path === 'fontSize' || path === 'lineHeight') {
      if (trimmed) style[path] = trimmed;
      else delete style[path];
    }
    return;
  }
  const head = path.slice(0, dot);
  const side = path.slice(dot + 1) as QuadSide;
  if (head !== 'margin' && head !== 'padding') return;
  if (side !== 'top' && side !== 'bottom' && side !== 'left' && side !== 'right') return;
  if (!style[head]) style[head] = {};
  if (trimmed) style[head]![side] = trimmed;
  else delete style[head]![side];
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
}

/** Render a property panel for a given scope. The schema is looked up via
 *  `schemaFor(scope)`. If the matrix has no row for the scope, an empty
 *  body is rendered (defensive — caller should have verified). */
// ──────────────────────────────────────────────────────────────────────────
// Block style wrapper
// ──────────────────────────────────────────────────────────────────────────

/**
 * Wrap rendered block HTML with a styled outer div. The wrapper is always
 * emitted (even when the block has no style yet) so the
 * `data-styled-block-id` hook is available for `applyBlockStyleToDOM()`
 * to live-update the very first edit without forcing a re-render.
 *
 * Custom HTML attributes (`attrs.class`, `attrs.id`) come from the user's
 * Identifiers panel and are sanitized through `sanitizeCssIdent()` before
 * being merged into the wrapper. This is what lets `customCss` selectors
 * like `.my-block` or `#hero` target an individual block.
 */
export function styleWrap(
  block: { id: string; type: string; style?: CommonStyle; attrs?: { class?: string; id?: string } },
  inner: string,
): string {
  const inlineStyle = buildInlineStyle(schemaFor(block.type), block.style);
  const styleAttr = inlineStyle ? ` style="${escapeHtmlAttr(inlineStyle)}"` : '';

  const customClass = sanitizeCssIdent(block.attrs?.class ?? '', 'multi');
  const classAttr = customClass ? ` nospress-block-style--custom ${escapeHtmlAttr(customClass)}` : '';

  const customId = sanitizeCssIdent(block.attrs?.id ?? '', 'single');
  const idAttr = customId ? ` id="${escapeHtmlAttr(customId)}"` : '';

  return `<div class="nospress-block-style${classAttr}" data-styled-block-id="${block.id}"${idAttr}${styleAttr}>${inner}</div>`;
}

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
      <div class="nospress-prop-row nospress-prop-row--color">
        <label class="nospress-prop-row__label">${escapeHtmlAttr(e.label)}</label>
        <input type="text" class="input nospress-prop-row__input nospress-prop-row__input--narrow"
               data-style-scope="${scopeAttr}" data-style-field="${e.key}"
               value="${value}" placeholder="${escapeHtmlAttr(e.placeholder)}" />
        <span class="nospress-prop-color-picker">
          <button type="button"
                  class="nospress-prop-color-trigger"
                  style="background: ${escapeHtmlAttr(triggerBg)}"
                  aria-label="Pick color"></button>
          <div class="nospress-prop-color-popover" hidden>
            ${paletteSwatches}
            <label class="nospress-prop-color-swatch nospress-prop-color-swatch--custom" aria-label="Custom color">
              <input type="color" class="nospress-prop-color-native" />
            </label>
          </div>
        </span>
      </div>
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

  const body = schema.map(entry =>
    entry.kind === 'single' ? single(entry) : quad(entry)
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
