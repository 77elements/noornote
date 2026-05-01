/**
 * BlockRenderer — central switch that turns a sequence of v2 blocks into HTML.
 *
 * Slice 4 status:
 * - Renderable: heading, text, list, divider, links (readonly + editable)
 * - Skipped (rendered as empty string): bookmark-folder
 *     → still mounted via ProfileListsComponent at the end of NospressView
 *     until a later slice moves bookmark-folder rendering inline.
 * - Placeholder: image, gallery, embed, columns
 *     → renderers come in later slices.
 */

import type { Block } from './types';
import { styleWrap } from './styles';
import { renderHeading } from './renderers/HeadingRenderer';
import { renderText } from './renderers/TextRenderer';
import { renderList } from './renderers/ListRenderer';
import { renderDivider } from './renderers/DividerRenderer';
import { renderLinks } from './renderers/LinksRenderer';
import { renderBookmarkFolder } from './renderers/BookmarkFolderRenderer';
import { renderImage } from './renderers/ImageRenderer';
import { renderGallery } from './renderers/GalleryRenderer';
import { renderEmbed } from './renderers/EmbedRenderer';
import { renderColumns } from './renderers/ColumnsRenderer';
import { renderDmButton } from './renderers/DmButtonRenderer';

export interface BlockRenderOptions {
  editable?: boolean;
}

export class BlockRenderer {
  static renderAll(blocks: Block[], opts: BlockRenderOptions = {}): string {
    return blocks.map(b => BlockRenderer.renderOne(b, opts)).join('');
  }

  static renderOne(block: Block, opts: BlockRenderOptions = {}): string {
    const editable = opts.editable === true;
    const inner = (() => {
      switch (block.type) {
        case 'heading':         return renderHeading(block, editable);
        case 'text':            return renderText(block, editable);
        case 'list':            return renderList(block, editable);
        case 'divider':         return renderDivider(block, editable);
        case 'links':           return renderLinks(block, editable);
        case 'bookmark-folder': return renderBookmarkFolder(block, editable);
        case 'image':           return renderImage(block, editable);
        case 'gallery':         return renderGallery(block, editable);
        case 'embed':           return renderEmbed(block, editable);
        case 'columns':         return renderColumns(block, { editable });
        case 'dm-button':       return renderDmButton(block, editable);
      }
    })();
    return styleWrap(block, inner);
  }
}
