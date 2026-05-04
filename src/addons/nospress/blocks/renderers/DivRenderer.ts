/**
 * Generic block-level wrapper. Renders as `<div>` by default; the tag can
 * be switched via a CustomDropdown (header / footer / main / section /
 * article / aside / nav / fieldset). Optional text content sits inside.
 *
 * Use case: the user wants a semantic landmark (e.g. <header>) or a
 * targetable wrapper (`#hero`, `.stripe`) without inventing a new block
 * type for every variant. Standard block style + attrs apply.
 */

import DOMPurify from 'dompurify';
import { escapeHtml, escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import { DIV_TAGS, type Block, type DivTag } from '../types';

function safeTag(raw: string | undefined): DivTag {
  return (DIV_TAGS as readonly string[]).includes(raw ?? '') ? (raw as DivTag) : 'div';
}

export function renderDiv(block: Extract<Block, { type: 'div' }>, editable = false): string {
  const tag = safeTag(block.tag);

  if (editable) {
    const content = escapeHtml(block.content ?? '');
    const inner = `
      <div class="nospress-block-div__tag-slot" data-block-dropdown="div-tag" data-block-id="${block.id}" data-current-value="${escapeHtmlAttr(tag)}"></div>
      <textarea class="textarea nospress-block-div__content" data-block-id="${block.id}" data-field="content" placeholder="Optional content...">${content}</textarea>
    `;
    return wrapEditable(block.id, 'div', inner);
  }

  const content = DOMPurify.sanitize(block.content ?? '');
  return `<${tag} class="nospress-block-div">${content}</${tag}>`;
}
