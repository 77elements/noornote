/**
 * Shared catalog of block types for the editor UI.
 *
 * Used by:
 *   - BlockLibraryView (catalog list with [Apply] buttons in the SCC tab)
 *   - CursorRow (slash-menu dropdown when user types `/` in an empty cursor)
 *
 * `enabled: false` means the renderer/editor for that block type is not
 * yet implemented. The Library shows a [Soon] label and the slash-menu
 * filters them out so users don't pick something that won't render.
 */

import type { BlockType } from './types';

export interface BlockTypeMeta {
  type: BlockType;
  label: string;
  description: string;
  icon: string;
  enabled: boolean;
}

export const BLOCK_CATALOG: BlockTypeMeta[] = [
  { type: 'heading',         label: 'Heading',         description: 'Section title (h1/h2/h3)',                icon: '◆', enabled: true },
  { type: 'text',            label: 'Text',            description: 'Plain paragraph with line breaks',         icon: '¶', enabled: true },
  { type: 'list',            label: 'Custom List',     description: 'Title + bullet items',                     icon: '☰', enabled: true },
  { type: 'links',           label: 'Links',           description: 'List of clickable links with labels',      icon: '🔗', enabled: true },
  { type: 'divider',         label: 'Divider',         description: 'Horizontal separator line',                icon: '─', enabled: true },
  { type: 'image',           label: 'Image',           description: 'Single image with optional caption',       icon: '🖼', enabled: true },
  { type: 'gallery',         label: 'Gallery',         description: 'Multi-image grid',                         icon: '⚏', enabled: true },
  { type: 'embed',           label: 'Nostr Embed',     description: 'Embed a Nostr note or article',            icon: '🔮', enabled: true },
  { type: 'bookmark-folder', label: 'Bookmark Folder', description: 'Mount an existing bookmark folder',        icon: '📁', enabled: true },
  { type: 'columns',         label: 'Columns',         description: '2- or 3-column layout',                    icon: '⊞', enabled: false },
];
