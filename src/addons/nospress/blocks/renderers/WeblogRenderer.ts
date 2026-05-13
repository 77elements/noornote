import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import { styleWrap } from '../styles';
import type { Block } from '../types';

/**
 * Weblog block — renders the page owner's kind-1 timeline filtered by
 * hashtags as a WordPress-style blog list. Per-post NoteUI render so
 * logged-in visitors get full ISL (reply / like / zap / repost).
 *
 * The actual fetch + render happens after the page HTML is in the DOM
 * — see weblogMount.ts.
 *
 * V1 scope:
 *   - Owner-only (pubkey override TBD)
 *   - Hashtag filter (case-insensitive, leading # stripped)
 *   - kind 1 only
 *   - Load-more pagination, no numbered/infinite
 *   - Top-level posts only (no replies, no reposts unless toggled on)
 */
export function renderWeblog(block: Extract<Block, { type: 'weblog' }>, editable = false): string {
  const pubkey = block.pubkey ?? '';
  const hashtags = (block.hashtags ?? []).join(',');
  const postsPerPage = block.postsPerPage ?? 5;
  const includeWithoutHash = block.includeWithoutHash === true; // default false
  const excludeReplies = block.excludeReplies !== false; // default true
  const excludeReposts = block.excludeReposts === true; // default false
  const includeReplies = !excludeReplies;

  const mountAttrs = `data-weblog-mount data-block-id="${block.id}" data-pubkey="${escapeHtmlAttr(pubkey)}" data-hashtags="${escapeHtmlAttr(hashtags)}" data-posts-per-page="${postsPerPage}" data-include-without-hash="${includeWithoutHash ? '1' : '0'}" data-exclude-replies="${excludeReplies ? '1' : '0'}" data-exclude-reposts="${excludeReposts ? '1' : '0'}"`;

  if (editable) {
    const slot = `<div class="nospress-block-weblog" ${mountAttrs}>
      <div class="nospress-block-weblog__loading pulsate">Loading posts…</div>
    </div>`;
    const editForm = `
      <div class="nospress-block-weblog__edit">
        <div class="form__row">
          <label>Author pubkey (npub) — leave empty for page owner</label>
          <input type="text" class="input" data-block-id="${block.id}" data-field="weblog-pubkey" value="${escapeHtmlAttr(pubkey)}" placeholder="npub1… (optional)" />
        </div>
        <div class="form__row">
          <label>Hashtags (comma-separated, case-insensitive, no #) — empty for all</label>
          <input type="text" class="input" data-block-id="${block.id}" data-field="weblog-hashtags" value="${escapeHtmlAttr(hashtags)}" placeholder="blog, longread, …" />
        </div>
        <div class="form__row">
          <div class="switch-container">
            <label class="switch-label" title="Also match posts containing the term in content without a leading #">
              <span class="switch-text">Match term also without #</span>
              <div class="switch-toggle">
                <input type="checkbox" class="switch-input" data-block-id="${block.id}" data-field="weblog-include-without-hash" ${includeWithoutHash ? 'checked' : ''} />
                <span class="switch-slider"></span>
              </div>
            </label>
          </div>
        </div>
        <div class="form__row">
          <label>Posts per page</label>
          <input type="number" class="input" data-block-id="${block.id}" data-field="weblog-posts-per-page" value="${postsPerPage}" min="1" max="20" />
        </div>
        <div class="form__row">
          <div class="switch-container">
            <label class="switch-label">
              <span class="switch-text">Including user's replies</span>
              <div class="switch-toggle">
                <input type="checkbox" class="switch-input" data-block-id="${block.id}" data-field="weblog-include-replies" ${includeReplies ? 'checked' : ''} />
                <span class="switch-slider"></span>
              </div>
            </label>
          </div>
        </div>
        <div class="form__row">
          <label>
            <input type="checkbox" data-block-id="${block.id}" data-field="weblog-exclude-reposts" ${excludeReposts ? 'checked' : ''} />
            Exclude reposts
          </label>
        </div>
      </div>
      ${slot}
    `;
    return wrapEditable(block.id, 'weblog', editForm);
  }

  return styleWrap(
    block,
    `<div class="nospress-block-weblog__loading pulsate">Loading posts…</div>`,
    {
      tag: 'div',
      baseClass: 'nospress-block-weblog',
      extraAttrs: mountAttrs,
    },
  );
}
