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
  // 1. Generic HTML container (always first after Page + Custom CSS).
  { type: 'div',             label: 'DIV',             description: 'Generic block-level wrapper — switch tag to header / section / fieldset / etc.', icon: '▭', enabled: true },

  // 2. Native HTML primitives — 1:1 mapping to a single element.
  { type: 'heading',         label: 'Heading',         description: 'Section title (h1/h2/h3)',                icon: '◆', enabled: true },
  { type: 'text',            label: 'Text',            description: 'Plain paragraph with line breaks',         icon: '¶', enabled: true },
  { type: 'divider',         label: 'Divider',         description: 'Horizontal separator line',                icon: '─', enabled: true },
  { type: 'quote',           label: 'Quote',           description: 'Pull quote with optional author and source',       icon: '❝', enabled: true },
  { type: 'image',           label: 'Image',           description: 'Single image with optional caption',       icon: '🖼', enabled: true },
  { type: 'video',           label: 'Video',           description: 'Single video with optional caption (mp4 / webm)',  icon: '🎬', enabled: true },
  { type: 'audio',           label: 'Audio',           description: 'Audio player for podcasts, music, voice notes',    icon: '🎵', enabled: true },
  { type: 'button-cta',      label: 'Button',          description: 'Call-to-action button linking to any URL',         icon: '🔘', enabled: true },

  // 3. Composite / multi-element blocks.
  { type: 'list',            label: 'Custom List',     description: 'Title + bullet items',                     icon: '☰', enabled: true },
  { type: 'links',           label: 'Links',           description: 'List of clickable links with labels',      icon: '🔗', enabled: true },
  { type: 'gallery',         label: 'Gallery',         description: 'Multi-image grid',                         icon: '⚏', enabled: true },
  { type: 'columns',         label: 'Columns',         description: 'Multi-column layout (19 presets)',         icon: '⊞', enabled: true },

  // 4. Nostr / NoorNote-specific blocks (consume on-relay data).
  { type: 'embed',           label: 'Nostr Embed',     description: 'Embed a Nostr note or article',            icon: '🔮', enabled: true },
  { type: 'bookmark-folder', label: 'Bookmark Folder', description: 'Mount an existing bookmark folder',        icon: '📁', enabled: true },
  { type: 'dm-button',       label: 'DM Button',       description: 'Button that opens a DM to the page owner', icon: '✉', enabled: true },
  { type: 'profile-card',    label: 'Profile Card',    description: 'Avatar + display name + NIP-05 of the page owner', icon: '👤', enabled: true },
  { type: 'articles-list',   label: 'Articles',        description: 'Long-form NIP-23 articles by the page owner',      icon: '📰', enabled: true },
  { type: 'weblog',          label: 'Weblog',          description: 'Owner notes filtered by hashtags — your blog feed', icon: '📝', enabled: true },

  // 5. Site-structure blocks.
  { type: 'nav-menu',        label: 'Nav Menu',        description: 'Site navigation rendered as <nav><ul><li><a>',     icon: '🧭', enabled: true },
];
