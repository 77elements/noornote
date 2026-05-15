import { sanitizeUserHtml } from '../../../../helpers/sanitizeUserHtml';
import { escapeHtml } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import { styleWrap } from '../styles';
import { TEXT_BLOCK_TAGS, type Block, type TextBlockTag } from '../types';

const TEXT_TAG_SET = new Set<string>(TEXT_BLOCK_TAGS);

function safeTag(raw: string | undefined): TextBlockTag {
  return raw && TEXT_TAG_SET.has(raw) ? (raw as TextBlockTag) : 'p';
}

export function renderText(block: Extract<Block, { type: 'text' }>, editable = false): string {
  const tag = safeTag(block.tag);

  if (editable) {
    // Composer holds the textarea only — the tag picker lives in the
    // Properties panel's extras slot (rendered by NospressView), so
    // semantic tag changes don't reflow the block-edit toolbar layout.
    const inner = `<textarea class="nospress-block-text__input textarea textarea--small" data-block-id="${block.id}" data-field="content" placeholder="Text content...">${escapeHtml(block.content)}</textarea>`;
    const linkBtn = `
      <button type="button" class="nospress-block-edit__btn" data-block-id="${block.id}" data-action="insert-link" title="Insert link" aria-label="Insert link">
        <svg width="14" height="14"><use href="#icon-link"/></svg>
      </button>
    `;
    return wrapEditable(block.id, 'text', inner, linkBtn);
  }

  // Readonly: self-wrap on the chosen tag (`<p>` by default, `<h1>`..`<h6>`
  // when the user picked one in Properties) so the user's `style` payload
  // lands directly on the semantic element and inherits-via-default sizing
  // works (`<h1>` is `2em` of its parent — wrapping it in an extra div
  // would shadow that).
  const content = sanitizeUserHtml(block.content);
  const baseClass = tag === 'p'
    ? 'nospress-block-text'
    : `nospress-block-text nospress-block-text--${tag}`;
  return styleWrap(block, content, { tag, baseClass });
}
