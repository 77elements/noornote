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
import { renderProfileCard } from './renderers/ProfileCardRenderer';
import { renderQuote } from './renderers/QuoteRenderer';
import { renderButtonCta } from './renderers/ButtonCtaRenderer';
import { renderVideo } from './renderers/VideoRenderer';
import { renderAudio } from './renderers/AudioRenderer';
import { renderArticlesList } from './renderers/ArticlesListRenderer';
import { renderWeblog } from './renderers/WeblogRenderer';
import { renderDiv } from './renderers/DivRenderer';
import { renderNavMenu } from './renderers/NavMenuRenderer';

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
        case 'profile-card':    return renderProfileCard(block, editable);
        case 'quote':           return renderQuote(block, editable);
        case 'button-cta':      return renderButtonCta(block, editable);
        case 'video':           return renderVideo(block, editable);
        case 'audio':           return renderAudio(block, editable);
        case 'articles-list':   return renderArticlesList(block, editable);
        case 'weblog':          return renderWeblog(block, editable);
        case 'div':             return renderDiv(block, { editable });
        case 'nav-menu':        return renderNavMenu(block, editable);
      }
    })();
    // The editor is a schematic composer — no live preview of user styles.
    // We still emit a wrapper so the click-to-select hook (data-styled-block-id)
    // works, but skip the inline `style`, custom class, and id attributes that
    // styleWrap injects for the public render path.
    if (editable) {
      return `<div class="nospress-block-style" data-styled-block-id="${block.id}">${inner}</div>`;
    }
    // Div blocks self-wrap with the user-chosen tag — see renderDiv.
    if (block.type === 'div') return inner;
    return styleWrap(block, inner);
  }
}
