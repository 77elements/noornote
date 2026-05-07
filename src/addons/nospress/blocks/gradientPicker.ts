/**
 * NosPress Gradient Picker — multi-stop CSS gradient editor.
 *
 * The editor is opened from the Background row's "gradient" swatch in the
 * property panel. Holds a {@link GradientDraft} while the user tweaks
 * stops, type, direction, repeat, and unit. On Apply, serializes to a
 * standard CSS gradient string and writes it back into the property
 * panel's text input.
 *
 * Parsing is forgiving but tailored for our own output format. If the
 * existing value in the text input doesn't match a gradient we generated,
 * the editor opens with sensible defaults instead of bailing.
 */

import { escapeHtmlAttr } from '../../../helpers/escapeHtml';
import type { PaletteKey } from './siteSettings';
import { renderPaletteSwatches, resolvePaletteVars } from './styles';

export type GradientType = 'linear' | 'radial' | 'conic';
export type GradientUnit = 'percent' | 'pixel';

export interface GradientStop {
  /** CSS color value: hex, rgb(), or `var(--color-X)`. */
  color: string;
  /** Position along the gradient axis, 0–100 (interpreted via `unit`). */
  position: number;
}

export interface GradientDraft {
  type: GradientType;
  /** Direction angle in degrees (0–360). Used by linear and conic. */
  angle: number;
  stops: GradientStop[];
  repeat: boolean;
  unit: GradientUnit;
  /** Relevant when stacking with a background-image — generates the gradient
   *  before the rest of the existing background value when true. Currently
   *  cosmetic in NosPress v1 (no separate bg-image field), kept for UI
   *  parity with the spec. */
  aboveBackgroundImage: boolean;
}

const UNIT_TO_CSS: Record<GradientUnit, string> = {
  percent: '%',
  pixel: 'px',
};

/** Default 2-stop linear gradient — top to bottom, $color-4 to $color-6
 *  (the existing palette's pink → green pair, gives a recognizable visual
 *  the user is likely to tweak from rather than accept). */
export function defaultGradient(): GradientDraft {
  return {
    type: 'linear',
    angle: 180,
    stops: [
      { color: 'var(--color-4)', position: 0 },
      { color: 'var(--color-6)', position: 100 },
    ],
    repeat: false,
    unit: 'percent',
    aboveBackgroundImage: false,
  };
}

/** Serialize a draft to a CSS gradient value. */
export function formatGradient(draft: GradientDraft): string {
  const fnName = draft.repeat
    ? `repeating-${draft.type}-gradient`
    : `${draft.type}-gradient`;
  const unit = UNIT_TO_CSS[draft.unit];
  const stopsCss = draft.stops
    .map(s => `${s.color} ${s.position}${unit}`)
    .join(', ');

  if (draft.type === 'linear') {
    return `${fnName}(${draft.angle}deg, ${stopsCss})`;
  }
  if (draft.type === 'conic') {
    return `${fnName}(from ${draft.angle}deg, ${stopsCss})`;
  }
  // radial: omit angle, default `circle`
  return `${fnName}(circle, ${stopsCss})`;
}

/** Try to parse a gradient string back into a draft. Tailored for our own
 *  output format. Returns null for anything we can't reliably parse. */
export function parseGradient(css: string): GradientDraft | null {
  if (!css) return null;
  const trimmed = css.trim();
  const m = trimmed.match(/^(repeating-)?(linear|radial|conic)-gradient\((.+)\)$/i);
  if (!m) return null;

  const repeat = !!m[1];
  const type = m[2]!.toLowerCase() as GradientType;
  const inner = m[3]!.trim();

  // Split top-level commas (skip those inside `var(...)`, `rgb(...)`, etc.).
  const parts = splitTopLevel(inner, ',').map(p => p.trim());
  if (parts.length < 2) return null;

  let angle = 180;
  let stopsStart = 0;

  if (type === 'linear') {
    const angleMatch = parts[0]!.match(/^(\d+(?:\.\d+)?)\s*deg$/i);
    if (angleMatch) {
      angle = parseFloat(angleMatch[1]!);
      stopsStart = 1;
    }
  } else if (type === 'conic') {
    const conicMatch = parts[0]!.match(/^from\s+(\d+(?:\.\d+)?)\s*deg/i);
    if (conicMatch) {
      angle = parseFloat(conicMatch[1]!);
      stopsStart = 1;
    }
  } else if (type === 'radial') {
    // First part is shape/position keyword (e.g. "circle"). Skip it.
    if (/^(circle|ellipse|at\s|closest|farthest)/i.test(parts[0]!)) stopsStart = 1;
  }

  const stops: GradientStop[] = [];
  let unit: GradientUnit = 'percent';
  for (let i = stopsStart; i < parts.length; i++) {
    const stopMatch = parts[i]!.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*(%|px)$/i);
    if (!stopMatch) return null;
    const color = stopMatch[1]!.trim();
    const position = parseFloat(stopMatch[2]!);
    const u = stopMatch[3]!.toLowerCase();
    if (u === 'px') unit = 'pixel';
    stops.push({ color, position });
  }
  if (stops.length < 2) return null;

  return {
    type,
    angle,
    stops,
    repeat,
    unit,
    aboveBackgroundImage: false,
  };
}

/** Split `s` on `sep` only at top level (ignore separators inside parens). */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Render the gradient editor HTML into the popover. The editor expects
 *  a back button (returns to swatches), a preview, a multi-stop slider,
 *  a per-stop color picker (palette + custom), Type / Angle / Repeat /
 *  Unit / Above-BG controls, plus Apply / Cancel. */
export function renderGradientEditor(
  draft: GradientDraft,
  selectedStopIndex: number,
  palette: Partial<Record<PaletteKey, string>> = {},
): string {
  // Editor preview uses literal hex from the user's palette so the bands /
  // stops / track render the colors the user actually picked. The stored
  // stop value stays as `var(--color-N)` so the published page tracks any
  // palette change dynamically.
  const previewCss = resolvePaletteVars(formatGradient(draft), palette);
  const angleVisible = draft.type === 'linear' || draft.type === 'conic';
  const selectedStop = draft.stops[selectedStopIndex] ?? draft.stops[0]!;
  const unit = UNIT_TO_CSS[draft.unit];

  const stopHandles = draft.stops.map((s, i) => `
    <button type="button"
            class="nospress-gradient-stop ${i === selectedStopIndex ? 'is-selected' : ''}"
            data-gradient-stop-index="${i}"
            style="left: ${s.position}%; background: ${escapeHtmlAttr(resolvePaletteVars(s.color, palette))}"
            aria-label="Stop ${i + 1}"></button>
  `).join('');

  // Swatch click writes the LITERAL HEX from the user's palette into the
  // gradient stop, not `var(--color-N)`. Editor preview, stored value, and
  // public-page render all see the same string — no late-binding mismatch.
  const paletteSwatches = renderPaletteSwatches(palette, 'gradient-stop-color', (k) => palette[k] ?? '');

  return `
    <div class="nospress-gradient-editor">
      <div class="nospress-gradient-preview" style="background: ${escapeHtmlAttr(previewCss)}"></div>

      <div class="nospress-gradient-editor__row">
        <div class="nospress-gradient-track" data-gradient-track style="background: ${escapeHtmlAttr(resolvePaletteVars(linearOnlyForTrack(draft), palette))}">
          ${stopHandles}
        </div>
        <div class="nospress-gradient-editor__stop-actions">
          <button type="button" class="btn btn--mini btn--passive" data-gradient-add-stop>+ Add stop</button>
          ${draft.stops.length > 2 ? `<button type="button" class="btn btn--mini btn--passive btn--danger" data-gradient-remove-stop>× Remove</button>` : ''}
        </div>
      </div>

      <div class="nospress-gradient-editor__row">
        <label>Stop color</label>
        <input type="text" class="input" data-gradient-stop-color-input value="${escapeHtmlAttr(selectedStop.color)}" />
        <div class="nospress-gradient-editor__palette">
          ${paletteSwatches}
          <button type="button" class="nospress-prop-color-swatch nospress-prop-color-swatch--custom" aria-label="Custom color">
            <input type="color" class="nospress-prop-color-native" data-gradient-stop-color-native />
          </button>
        </div>
      </div>

      <div class="nospress-gradient-editor__row">
        <label>Stop position</label>
        <span class="nospress-input-suffix">
          <input type="number" class="input" data-gradient-stop-position min="0" max="100" step="1" value="${selectedStop.position}" />
          <span class="nospress-input-suffix__hint">${escapeHtmlAttr(unit)}</span>
        </span>
      </div>

      <div class="nospress-gradient-editor__row">
        <label>Type</label>
        <div data-gradient-type-mount></div>
      </div>

      ${angleVisible ? `
        <div class="nospress-gradient-editor__row">
          <label>Direction</label>
          <input type="range" class="nospress-gradient-editor__angle" min="0" max="360" step="1" value="${draft.angle}" data-gradient-angle-range />
          <span class="nospress-input-suffix">
            <input type="number" class="input" min="0" max="360" step="1" value="${draft.angle}" data-gradient-angle-number />
            <span class="nospress-input-suffix__hint">°</span>
          </span>
        </div>
      ` : ''}

      <div class="nospress-gradient-editor__row">
        <label class="nn-checkbox">
          <input type="checkbox" data-gradient-repeat ${draft.repeat ? 'checked' : ''} />
          <span>Repeat gradient</span>
        </label>
      </div>

      <div class="nospress-gradient-editor__row">
        <label>Unit</label>
        <div data-gradient-unit-mount></div>
      </div>

      <div class="nospress-gradient-editor__row">
        <label class="nn-checkbox">
          <input type="checkbox" data-gradient-above-bg ${draft.aboveBackgroundImage ? 'checked' : ''} />
          <span>Above background image</span>
        </label>
      </div>

      <div class="nospress-gradient-editor__actions">
        <button type="button" class="btn" data-gradient-apply>Apply</button>
        <button type="button" class="btn btn--passive" data-gradient-cancel>Cancel</button>
      </div>
    </div>
  `;
}

/** The slider track always renders a horizontal linear-gradient even when
 *  the gradient type is radial/conic — the track's purpose is to show the
 *  stop positions side-by-side, not the final shape. */
function linearOnlyForTrack(draft: GradientDraft): string {
  const stopsCss = draft.stops
    .map(s => `${s.color} ${s.position}%`)
    .join(', ');
  return `linear-gradient(90deg, ${stopsCss})`;
}
