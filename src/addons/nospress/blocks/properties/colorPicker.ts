/**
 * Color-picker primitives shared by the Properties panel and the gradient
 * editor:
 *   - `resolvePaletteVars`     — substitute `var(--color-N)` → literal hex
 *                                from a given palette (editor-only preview)
 *   - `renderPaletteSwatches`  — row of palette swatches with data-attrs
 *   - `renderColorPickerRow`   — label + narrow input + circular trigger
 *                                + hidden swatches popover (+ gradient slot)
 */

import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { PALETTE_KEYS, type PaletteKey } from '../siteSettings';

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
 * Used by the Properties-panel color/background and text-shadow rows;
 * designed to scale to the per-block mobile-menu sub-scope where 5+
 * color rows live alongside each other.
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
