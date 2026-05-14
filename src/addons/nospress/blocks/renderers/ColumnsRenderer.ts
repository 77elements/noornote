/**
 * ColumnsRenderer — multi-column layout with nested blocks per column.
 *
 * Width per column comes from `block.layout` (number array of fr ratios,
 * e.g. `[1,2,1]` = 1/4 + 1/2 + 1/4). The picker exposes 19 presets; the
 * grid is driven inline via `style="grid-template-columns: 1fr 2fr 1fr"`.
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
 *
 * Layout-picker trigger (editable mode only): a button with a mini bars
 * preview of the current layout. NospressView attaches a click handler
 * that opens a modal with all 19 preset cards.
 */

import type { Block } from '../types';
import { BlockRenderer } from '../BlockRenderer';
import { wrapEditable } from './blockEditWrapper';
import { styleWrap } from '../styles';

export interface ColumnsRenderOptions {
  editable?: boolean;
  /** Optional per-column inner HTML override (used by NospressView in editable
   *  mode to inject the recursive cursor + block list output). */
  columnInner?: (colIndex: number) => string;
}

/** Build the inline `grid-template-columns` value from a ratio array.
 *  `[1,2,1]` → `1fr 2fr 1fr`. */
function gridTemplateFor(layout: number[]): string {
  return layout.map(r => `${r}fr`).join(' ');
}

/** Render a mini bars preview of a layout. Reused by the trigger button
 *  AND the modal cards so the visual signature stays identical. */
export function renderLayoutPreview(layout: number[]): string {
  const cols = gridTemplateFor(layout);
  const bars = layout.map(() => '<span></span>').join('');
  return `<span class="nospress-columns-layout-preview" style="grid-template-columns: ${cols};">${bars}</span>`;
}

export function renderColumns(
  block: Extract<Block, { type: 'columns' }>,
  opts: ColumnsRenderOptions = {}
): string {
  const editable = opts.editable === true;
  // Default-tab column orders ride along inline on each `__col`. Per-BP
  // overrides land via `buildBlockColumnsCss` as `@media` rules with
  // `!important`. Read the Default slot only — `block.style.columnOrder`
  // is the mobile-first base.
  const orders = block.style?.columnOrder;
  const orderFor = (idx: number): string => {
    const raw = orders?.[String(idx)];
    if (!raw) return '';
    // Cheap inline sanitization: keep integer / leading-minus only so a
    // stray paste can't poison the inline-style attribute.
    return /^-?\d+$/.test(raw.trim()) ? raw.trim() : '';
  };
  const cols: string[] = [];
  for (let c = 0; c < block.layout.length; c++) {
    const inner = opts.columnInner
      ? opts.columnInner(c)
      : BlockRenderer.renderAll(block.content[c] ?? [], { editable });
    const order = orderFor(c);
    const styleAttr = order ? ` style="order: ${order}"` : '';
    cols.push(`
      <div class="nospress-block-columns__col"
           data-columns-block-id="${block.id}"
           data-col-index="${c}"${styleAttr}>
        ${inner}
      </div>
    `);
  }

  const gridStyle = `--nospress-cols: ${gridTemplateFor(block.layout)}`;

  if (editable) {
    const layoutAttr = block.layout.join(',');
    const triggerHtml = `
      <button type="button"
              class="nospress-block-columns__layout-trigger"
              data-block-layout-trigger
              data-block-id="${block.id}"
              data-current-layout="${layoutAttr}"
              aria-label="Change column layout">
        ${renderLayoutPreview(block.layout)}
      </button>`;
    const inner = `
      ${triggerHtml}
      <div class="nospress-block-columns" data-columns-block-id="${block.id}" style="${gridStyle}">
        ${cols.join('')}
      </div>
    `;
    return wrapEditable(block.id, 'columns', inner);
  }

  // Readonly: self-wrap on the columns container so styles land directly
  // on it instead of on a wrapper div. Grid template flows in via the
  // `--nospress-cols` custom property, picked up by SCSS at tablet-up.
  return styleWrap(
    block,
    cols.join(''),
    {
      tag: 'div',
      baseClass: 'nospress-block-columns',
      extraAttrs: `data-columns-block-id="${block.id}"`,
      extraInlineStyle: gridStyle,
    },
  );
}
