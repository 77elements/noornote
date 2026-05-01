import DOMPurify from 'dompurify';
import { escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import type { Block } from '../types';

export function renderList(block: Extract<Block, { type: 'list' }>, editable = false): string {
  if (editable) {
    const titleInput = `<input type="text" class="nospress-block-list__title-input input" data-block-id="${block.id}" data-field="title" value="${escapeHtmlAttr(block.title || '')}" placeholder="List title (optional)..." />`;
    const itemsHtml = block.items.map((item, i) => `
      <div class="nospress-block-list__item-row" data-item-index="${i}">
        <input type="text" class="nospress-block-list__item-input input" data-block-id="${block.id}" data-field="item" data-item-index="${i}" value="${escapeHtmlAttr(item)}" />
        <button type="button" class="nospress-block-edit__btn nospress-block-edit__btn--danger" data-block-id="${block.id}" data-action="delete-item" data-item-index="${i}" title="Remove" aria-label="Remove">
          <svg width="14" height="14"><use href="#icon-close"/></svg>
        </button>
      </div>
    `).join('');
    const addRow = `
      <div class="nospress-block-list__add-row">
        <input type="text" class="nospress-block-list__new-input input" data-block-id="${block.id}" data-field="new-item" placeholder="Add an entry..." />
        <button type="button" class="nospress-block-edit__btn" data-block-id="${block.id}" data-action="add-item" title="Add" aria-label="Add">
          <svg width="14" height="14"><use href="#icon-plus"/></svg>
        </button>
      </div>
    `;
    return wrapEditable(block.id, 'list', `${titleInput}<div class="nospress-block-list__items">${itemsHtml}</div>${addRow}`);
  }

  const titleHtml = block.title?.trim()
    ? `<h2 class="nospress-section__title">${DOMPurify.sanitize(block.title)}</h2>`
    : '';
  const itemsHtml = block.items
    .map(item => `<li class="nospress-section__item">${DOMPurify.sanitize(item)}</li>`)
    .join('');
  return `<div class="nospress-section nospress-block-list">${titleHtml}<ul class="nospress-section__items">${itemsHtml}</ul></div>`;
}
