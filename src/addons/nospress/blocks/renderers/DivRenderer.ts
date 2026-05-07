/**
 * Generic block-level wrapper that can host other blocks. Tag defaults to
 * `div`; CustomDropdown switches it to header / footer / main / section /
 * article / aside / nav / fieldset.
 *
 * Readonly: renders children via BlockRenderer.renderAll (recursive).
 * Editable: emits a slot — NospressView fills it via its own
 *   renderBlocksWithCursor pass so the active cursor row + nested editable
 *   blocks land at the right position.
 *
 * The slot exposes `data-div-block-id` so NospressView can attach the
 * empty-children click handler that drops the cursor inside the div.
 */

import { BlockRenderer } from '../BlockRenderer';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import { styleWrap } from '../styles';
import { DIV_TAGS, type Block, type DivTag } from '../types';

function safeTag(raw: string | undefined): DivTag {
  return (DIV_TAGS as readonly string[]).includes(raw ?? '') ? (raw as DivTag) : 'div';
}

export interface RenderDivOptions {
  editable?: boolean;
  /** Editable mode: NospressView injects the recursive cursor-aware
   *  child render output here. */
  childrenInner?: () => string;
}

export function renderDiv(
  block: Extract<Block, { type: 'div' }>,
  opts: RenderDivOptions = {}
): string {
  const tag = safeTag(block.tag);
  const editable = opts.editable === true;

  if (editable) {
    const childrenHtml = opts.childrenInner ? opts.childrenInner() : '';
    const inner = `
      <div class="nospress-block-div__tag-slot" data-block-dropdown="div-tag" data-block-id="${block.id}" data-current-value="${escapeHtmlAttr(tag)}"></div>
      <div class="nospress-block-div__children" data-div-block-id="${block.id}">${childrenHtml}</div>
    `;
    return wrapEditable(block.id, 'div', inner);
  }

  // Self-wrapping readonly: the user-chosen tag IS the styled outer
  // element. BlockRenderer skips its default styleWrap for 'div', so we
  // don't end up with `<div class="nospress-block-style"><header>…`.
  const childrenHtml = BlockRenderer.renderAll(block.children, { editable: false });
  return styleWrap(block, childrenHtml, { tag, baseClass: 'nospress-block-div' });
}
