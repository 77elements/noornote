/**
 * Inline-style emit pipeline. Takes a flat `PropertyEntry[]` schema +
 * a `CommonStyle` payload and produces a `style="…"` declaration list.
 *
 * Two flavours:
 *   - `buildInlineStyle`           — base / Default-tab styles
 *   - `buildImportantInlineStyle`  — per-breakpoint overrides; every
 *                                    declaration suffixed with `!important`
 *                                    so it outranks the wrapper's inline
 *                                    base styles when the @media matches.
 *
 * Border legacy migration lives here too — `migrateLegacyBorder` hydrates
 * `borderWidth/borderStyle/borderColor` from an old `border` shorthand
 * when only the legacy field is present, so existing relay data renders
 * without a separate migration pass.
 */

import { sanitizeStyleValue } from './sanitize';
import { QUAD_SIDES, type BoxValues, type CommonStyle, type PropertyEntry } from './types';

/** Build the `style="…"` payload from a CommonStyle, restricted to schema.
 *
 *  `excludeKeys` lets a caller drop specific CommonStyle keys from the
 *  emission — used by flip-card to keep `background` / `border*` out of
 *  the wrapper so the same values can be redirected to the face
 *  selector instead (see `FlipCardRenderer` / `buildBlockFlipCardFaceCss`).
 *
 *  `includeKeys` is the inverse: when set, ONLY entries with a matching
 *  `.key` emit. Used by flip-card to compose the face's tiny
 *  background+border inline-style without re-deriving a separate schema. */
export function buildInlineStyle(
  schema: PropertyEntry[],
  styleIn: CommonStyle | undefined,
  excludeKeys?: Set<string>,
  includeKeys?: Set<string>,
): string {
  if (!styleIn) return '';
  const style = migrateLegacyBorder(styleIn);
  const parts: string[] = [];
  const push = (prop: string, value: string | undefined) => {
    if (!value) return;
    const v = sanitizeStyleValue(value);
    if (v) parts.push(`${prop}: ${v}`);
  };
  for (const entry of schema) {
    if (excludeKeys?.has(entry.key)) continue;
    if (includeKeys && !includeKeys.has(entry.key)) continue;
    if (entry.kind === 'single') {
      push(entry.cssProp, style[entry.key]);
    } else if (entry.kind === 'quad') {
      const box = style[entry.key];
      if (!box) continue;
      // Special case: `border-color` shorthand requires <color>{1,4};
      // filling missing sides with the literal `0` (the shorthand
      // composer's default) makes the declaration invalid and the
      // browser rejects the whole rule. Emit per-side
      // `border-<side>-color` for set sides only; unset sides keep
      // their inherited / currentColor default.
      if (entry.key === 'borderColor') {
        for (const side of QUAD_SIDES) push(`border-${side}-color`, box[side]);
        continue;
      }
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
      if (entry.skipInlineEmit) continue;
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

/** Same payload as `buildInlineStyle` but appends `!important` to every
 *  declaration so per-breakpoint overrides outrank the wrapper's inline
 *  base styles when their media query matches.
 *
 *  `excludeKeys` / `includeKeys` behave identically to `buildInlineStyle`. */
export function buildImportantInlineStyle(
  schema: PropertyEntry[],
  styleIn: CommonStyle | undefined,
  excludeKeys?: Set<string>,
  includeKeys?: Set<string>,
): string {
  if (!styleIn) return '';
  const style = migrateLegacyBorder(styleIn);
  const parts: string[] = [];
  const push = (prop: string, value: string | undefined) => {
    if (!value) return;
    const v = sanitizeStyleValue(value);
    if (v) parts.push(`${prop}: ${v} !important`);
  };
  for (const entry of schema) {
    if (excludeKeys?.has(entry.key)) continue;
    if (includeKeys && !includeKeys.has(entry.key)) continue;
    if (entry.kind === 'single') {
      push(entry.cssProp, style[entry.key]);
    } else if (entry.kind === 'quad') {
      const box = style[entry.key];
      if (!box) continue;
      // Same `border-color` per-side special case as buildInlineStyle:
      // the shorthand requires <color>{1,4}; literal `0` filler is
      // invalid and rejects the whole rule.
      if (entry.key === 'borderColor') {
        for (const side of QUAD_SIDES) push(`border-${side}-color`, box[side]);
        continue;
      }
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
      if (entry.skipInlineEmit) continue;
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
export function migrateLegacyBorder(style: CommonStyle): CommonStyle {
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
