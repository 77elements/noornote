/**
 * BlockRenderer — central switch that turns a sequence of v2 blocks into HTML.
 *
 * Slice 4 status:
 * - Renderable: heading, text, list, divider, links (readonly + editable)
 * - Skipped (rendered as empty string): bookmark-folder
 *     → still mounted via ProfileListsComponent at the end of MypageView
 *     until a later slice moves bookmark-folder rendering inline.
 * - Placeholder: image, gallery, embed, columns
 *     → renderers come in later slices.
 */

import type { Block } from './types';
import { renderHeading } from './renderers/HeadingRenderer';
import { renderText } from './renderers/TextRenderer';
import { renderList } from './renderers/ListRenderer';
import { renderDivider } from './renderers/DividerRenderer';
import { renderLinks } from './renderers/LinksRenderer';
import { renderBookmarkFolder } from './renderers/BookmarkFolderRenderer';
import { wrapEditable } from './renderers/blockEditWrapper';

export interface BlockRenderOptions {
  editable?: boolean;
}

export class BlockRenderer {
  static renderAll(blocks: Block[], opts: BlockRenderOptions = {}): string {
    return blocks.map(b => BlockRenderer.renderOne(b, opts)).join('');
  }

  static renderOne(block: Block, opts: BlockRenderOptions = {}): string {
    const editable = opts.editable === true;
    switch (block.type) {
      case 'heading':         return renderHeading(block, editable);
      case 'text':            return renderText(block, editable);
      case 'list':            return renderList(block, editable);
      case 'divider':         return renderDivider(block, editable);
      case 'links':           return renderLinks(block, editable);
      case 'bookmark-folder': return renderBookmarkFolder(block, editable);
      case 'image':
      case 'gallery':
      case 'embed':
      case 'columns': {
        const placeholder = `<div class="mypage-block-placeholder">[${block.type} block — renderer pending]</div>`;
        return editable ? wrapEditable(block.id, block.type, placeholder) : placeholder;
      }
    }
  }
}
