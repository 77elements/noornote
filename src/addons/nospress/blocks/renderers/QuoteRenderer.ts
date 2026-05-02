import DOMPurify from 'dompurify';
import { escapeHtml, escapeHtmlAttr } from '../../../../helpers/escapeHtml';
import { wrapEditable } from './blockEditWrapper';
import type { Block } from '../types';

/**
 * Quote block — pull-quote with optional attribution.
 *
 * Editable: textarea for the quote text + two inputs (author, source).
 * Readonly: <blockquote> with the text + an optional <footer> that joins
 * author and source on a single line ("— Author, Source").
 */
export function renderQuote(block: Extract<Block, { type: 'quote' }>, editable = false): string {
  if (editable) {
    const textInput = `<textarea class="nospress-block-quote__text textarea textarea--small" data-block-id="${block.id}" data-field="quote-text" placeholder="Quote text…">${escapeHtml(block.text)}</textarea>`;
    const authorInput = `<input type="text" class="input nospress-block-quote__author-input" data-block-id="${block.id}" data-field="quote-author" value="${escapeHtmlAttr(block.author || '')}" placeholder="Author (optional)" />`;
    const sourceInput = `<input type="text" class="input nospress-block-quote__source-input" data-block-id="${block.id}" data-field="quote-source" value="${escapeHtmlAttr(block.source || '')}" placeholder="Source (optional)" />`;
    return wrapEditable(block.id, 'quote', `${textInput}${authorInput}${sourceInput}`);
  }

  const text = DOMPurify.sanitize((block.text || '').trim());
  if (!text) return '';

  const author = (block.author || '').trim();
  const source = (block.source || '').trim();
  const attribution = [author, source].filter(Boolean).join(', ');
  const footer = attribution
    ? `<footer class="nospress-block-quote__footer">— ${escapeHtml(attribution)}</footer>`
    : '';

  return `<blockquote class="nospress-block-quote"><p class="nospress-block-quote__text-content">${text}</p>${footer}</blockquote>`;
}
