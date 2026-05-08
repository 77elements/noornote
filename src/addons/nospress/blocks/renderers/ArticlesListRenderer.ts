import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import { styleWrap } from '../styles';
import type { Block } from '../types';

/**
 * Articles List block — renders the page owner's NIP-23 long-form articles
 * (kind 30023) using the same `ProfileArticlesCarousel` component the
 * ProfileView already uses (horizontal scroll, drafts on own profile).
 *
 * The actual mount happens after the page HTML is in the DOM — see
 * articlesListMount.ts.
 *
 * `pubkey` is optional: empty = page owner.
 */
export function renderArticlesList(block: Extract<Block, { type: 'articles-list' }>, editable = false): string {
  const pubkey = block.pubkey ?? '';

  if (editable) {
    const slot = `<div class="nospress-block-articles-list" data-articles-list-mount data-block-id="${block.id}" data-pubkey="${escapeHtmlAttr(pubkey)}">
      <div class="nospress-block-articles-list__loading pulsate">Loading articles…</div>
    </div>`;
    const editForm = `
      <div class="nospress-block-articles-list__edit">
        <div class="form__row">
          <label>Author pubkey (npub) — leave empty for page owner</label>
          <input type="text" class="input" data-block-id="${block.id}" data-field="articles-pubkey" value="${escapeHtmlAttr(pubkey)}" placeholder="npub1… (optional)" />
        </div>
      </div>
      ${slot}
    `;
    return wrapEditable(block.id, 'articles-list', editForm);
  }

  return styleWrap(
    block,
    `<div class="nospress-block-articles-list__loading pulsate">Loading articles…</div>`,
    {
      tag: 'div',
      baseClass: 'nospress-block-articles-list',
      extraAttrs: `data-articles-list-mount data-block-id="${block.id}" data-pubkey="${escapeHtmlAttr(pubkey)}"`,
    },
  );
}
