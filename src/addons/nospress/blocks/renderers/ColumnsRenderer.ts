/**
 * ColumnsRenderer — 2- or 3-column layout with nested blocks per column.
 *
 * Readonly: pure CSS grid with each column rendering its own blocks list.
 * Editable: wraps via wrapEditable for the outer toolbar (move/delete/cursor),
 *   then renders each column as a slot. The slot HTML is a stub — NospressView
 *   recursively fills it via its own renderBlocksWithCursor pass so the
 *   active cursor row + nested editable blocks land in the right column.
 *
 * Each column slot exposes:
 *   data-columns-block-id  (the parent columns block id)
 *   data-col-index         (0-based column index)
 * NospressView reads those to attach per-column cursor + add/insert handlers.
 */

import type { Block } from '../types';
import { BlockRenderer } from '../BlockRenderer';
import { wrapEditable } from './blockEditWrapper';

export interface ColumnsRenderOptions {
  editable?: boolean;
  /** Optional per-column inner HTML override (used by NospressView in editable
   *  mode to inject the recursive cursor + block list output). */
  columnInner?: (colIndex: number) => string;
}

export function renderColumns(
  block: Extract<Block, { type: 'columns' }>,
  opts: ColumnsRenderOptions = {}
): string {
  const editable = opts.editable === true;
  const cols: string[] = [];
  for (let c = 0; c < block.count; c++) {
    const inner = opts.columnInner
      ? opts.columnInner(c)
      : BlockRenderer.renderAll(block.content[c] ?? [], { editable });
    cols.push(`
      <div class="nospress-block-columns__col"
           data-columns-block-id="${block.id}"
           data-col-index="${c}">
        ${inner}
      </div>
    `);
  }

  const countSwitcher = editable
    ? `<div class="nospress-block-columns__count-slot" data-block-dropdown="columns-count" data-block-id="${block.id}" data-current-value="${block.count}"></div>`
    : '';

  const inner = `
    ${countSwitcher}
    <div class="nospress-block-columns nospress-block-columns--${block.count}" data-columns-block-id="${block.id}">
      ${cols.join('')}
    </div>
  `;

  return editable ? wrapEditable(block.id, 'columns', inner) : inner;
}
