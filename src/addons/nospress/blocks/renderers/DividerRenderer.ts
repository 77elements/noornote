import { wrapEditable } from './blockEditWrapper';
import type { Block } from '../types';

export function renderDivider(block: Extract<Block, { type: 'divider' }>, editable = false): string {
  if (editable) {
    return wrapEditable(block.id, 'divider', `<hr class="nospress-block-divider" />`);
  }
  return `<hr class="nospress-block-divider" />`;
}
