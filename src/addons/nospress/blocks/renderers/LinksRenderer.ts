import { sanitizeUserHtml } from '../../../../helpers/sanitizeUserHtml';
import { sanitizeUrl } from '../../../../helpers/sanitizeUrl';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import type { Block } from '../types';

export function renderLinks(block: Extract<Block, { type: 'links' }>, editable = false): string {
  if (editable) {
    const titleInput = `<input type="text" class="nospress-block-links__title-input input" data-block-id="${block.id}" data-field="title" value="${escapeHtmlAttr(block.title || '')}" placeholder="Links title (optional)..." />`;
    const itemsHtml = block.items.map((item, i) => `
      <div class="nospress-block-links__item-row" data-item-index="${i}">
        <input type="text" class="nospress-block-links__label-input input" data-block-id="${block.id}" data-field="link-label" data-item-index="${i}" value="${escapeHtmlAttr(item.label || '')}" placeholder="Label" />
        <input type="text" class="nospress-block-links__url-input input" data-block-id="${block.id}" data-field="link-url" data-item-index="${i}" value="${escapeHtmlAttr(item.url || '')}" placeholder="https://..." />
        <button type="button" class="nospress-block-edit__btn nospress-block-edit__btn--danger" data-block-id="${block.id}" data-action="delete-link" data-item-index="${i}" title="Remove" aria-label="Remove">
          <svg width="14" height="14"><use href="#icon-close"/></svg>
        </button>
      </div>
    `).join('');
    const addBtn = `<button type="button" class="btn btn--passive btn--mini" data-block-id="${block.id}" data-action="add-link">+ Add link</button>`;
    return wrapEditable(block.id, 'links', `${titleInput}<div class="nospress-block-links__items-edit">${itemsHtml}</div>${addBtn}`);
  }

  const titleHtml = block.title?.trim()
    ? `<h3 class="nospress-block-links__title">${sanitizeUserHtml(block.title)}</h3>`
    : '';
  const itemsHtml = block.items
    .map(item => {
      const safeUrl = sanitizeUrl(item.url);
      if (!safeUrl) return '';
      const label = sanitizeUserHtml(item.label?.trim() || safeUrl);
      return `<a class="nospress-block-links__item" href="${escapeHtmlAttr(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    })
    .filter(Boolean)
    .join('');
  return `<div class="nospress-block-links">${titleHtml}<div class="nospress-block-links__items">${itemsHtml}</div></div>`;
}
