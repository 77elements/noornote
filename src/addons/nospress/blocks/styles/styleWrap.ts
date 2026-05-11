/**
 * `styleWrap` — block-level HTML wrapper emit.
 *
 * Every readonly block render goes through here. Produces the outer
 * element (with `data-styled-block-id`) carrying the user's inline
 * `style`, custom class, custom id, clip-path divider, and any
 * caller-supplied data attributes.
 *
 * Renderers that self-wrap on their semantic element (heading → <h1/2/3>,
 * text → <p>, quote → <blockquote>, dm-button → <button>, …) pass `tag`
 * and `baseClass` so user styles land directly on the semantic tag —
 * avoids the wrapper-div indirection that used to shadow inherited
 * properties like font-size.
 */

import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { buildInlineStyle } from './build';
import { schemaFor } from './catalog';
import { buildClipPath } from './divider';
import { sanitizeCssIdent } from './sanitize';
import type { CommonStyle } from './types';

/** HTML void elements — emitted self-closing so `<hr ...>` doesn't end up
 *  with an invalid closing tag. The list is intentionally narrow; only
 *  the elements actually used as block roots are covered. */
const VOID_ELEMENTS = new Set(['hr', 'br', 'img', 'input']);

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
