import { wrapEditable } from './blockEditWrapper';
import { styleWrap } from '../styles';
import type { Block } from '../types';

export function renderDivider(block: Extract<Block, { type: 'divider' }>, editable = false): string {
  if (editable) {
    return wrapEditable(block.id, 'divider', `<hr class="nospress-block-divider" />`);
  }
  // Self-wrap on `<hr>` (void element — styleWrap emits self-closing).
  return styleWrap(block, '', { tag: 'hr', baseClass: 'nospress-block-divider' });
}
