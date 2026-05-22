/**
 * Flip-card block — two-faced card that animates from front to back on
 * hover (desktop) or click (touch / explicit user opt-in).
 *
 * Public render lays out both faces stacked at the same grid slot
 * (`grid-area: 1 / 1`) wrapped in a 3D scene container. The `flip-effect`
 * attribute picks which CSS transform the SCSS applies (rotateY,
 * rotateX, or opacity fade). The flip transition uses `--flip-duration`
 * which the renderer mirrors from `block.flipDuration` so the user can
 * dial the timing without writing custom CSS. Touch + hover are gated by
 * `flip-trigger`: hover wires up purely via `:hover`, click toggles
 * `.is-flipped` from a tiny runtime in `flipCardRuntime.ts`.
 *
 * Editable mode shows a Front | Back segmented toggle on top of the
 * block, then the active side's children stack with the standard
 * cursor-injection pattern (NospressView fills the slot). The inactive
 * side stays in the data model but is not visible — the user switches
 * faces via the segmented button.
 */

import { BlockRenderer } from '../BlockRenderer';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import { buildInlineStyle, schemaFor, styleWrap } from '../styles';
import {
  FLIP_EFFECTS,
  FLIP_TRIGGERS,
  type Block,
  type FlipEffect,
  type FlipTrigger,
} from '../types';

export interface RenderFlipCardOptions {
  editable?: boolean;
  /** Active editing face ('front' | 'back'); determines which children
   *  array gets the cursor-row slot injected. Editor-only state — not
   *  persisted. Defaults to 'front'. */
  activeSide?: 'front' | 'back';
  /** Editor: NospressView injects the recursive cursor-aware child
   *  render output for the currently-active face here. */
  activeChildrenInner?: () => string;
}

function clampEffect(v: string | undefined): FlipEffect {
  return (FLIP_EFFECTS as readonly string[]).includes(v ?? '') ? (v as FlipEffect) : 'horizontal';
}

function clampTrigger(v: string | undefined): FlipTrigger {
  return (FLIP_TRIGGERS as readonly string[]).includes(v ?? '') ? (v as FlipTrigger) : 'hover';
}

/** Restrict free-form duration to a digit-only ms value or a `<n>s` /
 *  `<n>ms` token — anything else falls back to the default 600ms so the
 *  inline `--flip-duration` can't be poisoned by paste. */
function sanitizeDuration(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  if (/^\d+(ms|s)$/.test(v)) return v;
  if (/^\d+$/.test(v)) return `${v}ms`;
  return '600ms';
}

export function renderFlipCard(
  block: Extract<Block, { type: 'flip-card' }>,
  opts: RenderFlipCardOptions = {},
): string {
  const editable = opts.editable === true;
  const effect = clampEffect(block.flipEffect);
  const trigger = clampTrigger(block.flipTrigger);
  const duration = sanitizeDuration(block.flipDuration);

  if (editable) {
    const side = opts.activeSide === 'back' ? 'back' : 'front';
    const childrenHtml = opts.activeChildrenInner ? opts.activeChildrenInner() : '';
    const inner = `
      <div class="nospress-block-flip-card__edit">
        <div class="nospress-block-flip-card__side-toggle" role="tablist" aria-label="Active face">
          <button type="button"
                  class="nospress-block-flip-card__side-btn${side === 'front' ? ' is-active' : ''}"
                  data-flip-card-block-id="${block.id}"
                  data-flip-side="front"
                  role="tab"
                  aria-selected="${side === 'front'}">Front</button>
          <button type="button"
                  class="nospress-block-flip-card__side-btn${side === 'back' ? ' is-active' : ''}"
                  data-flip-card-block-id="${block.id}"
                  data-flip-side="back"
                  role="tab"
                  aria-selected="${side === 'back'}">Back</button>
        </div>
        <div class="form__row form__row--inline">
          <label>Flip effect</label>
          <div data-block-dropdown="flip-effect" data-block-id="${block.id}" data-current-value="${escapeHtmlAttr(effect)}"></div>
        </div>
        <div class="form__row form__row--inline">
          <label for="flip-duration-${block.id}">Timing</label>
          <input id="flip-duration-${block.id}" type="text" class="input" data-block-id="${block.id}" data-field="flip-duration" value="${escapeHtmlAttr(duration)}" placeholder="600ms" />
        </div>
        <div class="form__row form__row--inline">
          <label>Trigger</label>
          <div data-block-dropdown="flip-trigger" data-block-id="${block.id}" data-current-value="${escapeHtmlAttr(trigger)}"></div>
        </div>
        <div class="nospress-block-flip-card__face nospress-block-flip-card__face--${side}"
             data-flip-card-block-id="${block.id}"
             data-flip-side="${side}">${childrenHtml}</div>
      </div>
    `;
    return wrapEditable(block.id, 'flip-card', inner);
  }

  // Public render — both faces emit; SCSS handles the 3D flip. Trigger
  // and effect ride on data-attributes so SCSS can fork the transform
  // per variant. `--flip-duration` is inlined so each instance ticks at
  // its own configured pace. Click runtime toggles `.is-flipped` on the
  // outer wrapper; hover uses `:hover` directly.
  //
  // `background` + `border*` + `borderRadius` are intentionally
  // redirected from the wrapper to each face: the wrapper is fully
  // covered by the two stacked faces, so wrapper-level box decoration
  // never shows. Inlining the Default-tab values on each face puts them
  // where users actually see them. The per-BP emission is handled in
  // `buildBlockFlipCardFaceCss` (see `breakpointCss.ts`);
  // `excludeStyleKeys` keeps the same keys out of the wrapper's inline
  // emission so the redirect is single-sourced.
  const frontHtml = BlockRenderer.renderAll(block.frontChildren, { editable: false });
  const backHtml = BlockRenderer.renderAll(block.backChildren, { editable: false });
  const faceInline = buildInlineStyle(
    schemaFor('flip-card'),
    block.style,
    undefined,
    FLIP_CARD_FACE_KEYS,
  );
  const faceStyleAttr = faceInline ? ` style="${escapeHtmlAttr(faceInline)}"` : '';
  const inner = `
    <div class="nospress-block-flip-card__face nospress-block-flip-card__face--front"${faceStyleAttr}>${frontHtml}</div>
    <div class="nospress-block-flip-card__face nospress-block-flip-card__face--back"${faceStyleAttr}>${backHtml}</div>
  `;

  const extraAttrs = `data-flip-effect="${effect}" data-flip-trigger="${trigger}"${trigger === 'click' ? ` tabindex="0" role="button"` : ''}`;
  const extraInlineStyle = `--flip-duration: ${duration}`;

  return styleWrap(
    block,
    inner,
    {
      tag: 'div',
      baseClass: 'nospress-block-flip-card',
      extraAttrs,
      extraInlineStyle,
      excludeStyleKeys: FLIP_CARD_WRAPPER_EXCLUDES,
    },
  );
}

/** Style keys that are emitted on the face elements (inline for the
 *  Default tab, via `buildBlockFlipCardFaceCss` for per-BP @media rules)
 *  — never on the wrapper. Border + border-radius travel along with
 *  background because they describe the visible box, which is the face
 *  rather than the rotating wrapper. */
const FLIP_CARD_FACE_KEYS = new Set([
  'background',
  'borderWidth',
  'borderStyle',
  'borderColor',
  'borderRadius',
]);
const FLIP_CARD_WRAPPER_EXCLUDES = FLIP_CARD_FACE_KEYS;
