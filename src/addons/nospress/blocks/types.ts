/**
 * NosPress Block Engine — v2 type definitions
 *
 * v2 introduces a block-based layout where the page is an ordered list
 * of typed blocks. v1 (sections + separate mounts event) migrates to v2
 * on read via migrate.ts. v1 stays the canonical write format until the
 * editor is rewritten in a later slice.
 *
 * Block.id (crypto.randomUUID) is required for stable DOM keys during
 * drag/sort/edit. Generated once on creation, stable until the block is
 * deleted.
 */

export type Block =
  | { id: string; type: 'heading'; level: 1 | 2 | 3; text: string }
  | { id: string; type: 'text'; content: string }
  | { id: string; type: 'image'; url: string; alt?: string; caption?: string }
  | { id: string; type: 'gallery'; urls: string[] }
  | { id: string; type: 'links'; title?: string; items: { label: string; url: string }[] }
  | { id: string; type: 'list'; title?: string; items: string[] }
  | { id: string; type: 'embed'; nostrRef: string }
  | { id: string; type: 'bookmark-folder'; folderName: string }
  | { id: string; type: 'columns'; count: 2 | 3; content: Block[][] }
  | { id: string; type: 'divider' }
  | { id: string; type: 'dm-button'; label: string };

export type BlockType = Block['type'];

/**
 * Page-level style overrides. Values are raw CSS strings (e.g. "16px",
 * "#ff0000", "1.5"). Empty / unset fields fall back to the theme defaults.
 * Sanitized at render time before being placed into a `style="…"` attribute.
 */
export interface PageStyle {
  color?: string;
  background?: string;
  fontSize?: string;
  lineHeight?: string;
  margin?: { top?: string; bottom?: string; left?: string; right?: string };
  padding?: { top?: string; bottom?: string; left?: string; right?: string };
}

export interface NospressPageV2 {
  version: 2;
  title?: string;
  subtitle?: string;
  description?: string;
  blocks: Block[];
  style?: PageStyle;
}

export function isPageV2(data: unknown): data is NospressPageV2 {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as { version?: unknown; blocks?: unknown };
  return obj.version === 2 && Array.isArray(obj.blocks);
}

export function newId(): string {
  return crypto.randomUUID();
}

export function createBlock(type: BlockType): Block {
  const id = newId();
  switch (type) {
    case 'heading':         return { id, type, level: 2, text: '' };
    case 'text':            return { id, type, content: '' };
    case 'image':           return { id, type, url: '' };
    case 'gallery':         return { id, type, urls: [] };
    case 'links':           return { id, type, items: [] };
    case 'list':            return { id, type, items: [] };
    case 'embed':           return { id, type, nostrRef: '' };
    case 'bookmark-folder': return { id, type, folderName: '' };
    case 'columns':         return { id, type, count: 2, content: [[], []] };
    case 'divider':         return { id, type };
    case 'dm-button':       return { id, type, label: 'Send me a message' };
  }
}

/**
 * Locate a block by id anywhere in the page — top-level OR inside a
 * `columns` block's per-column content arrays. Returns the block plus
 * the parent array + index (for splice/move operations).
 *
 * Per design contract (see docs/todos/nospress.md), `columns` blocks may
 * NOT contain other `columns` blocks, so we recurse exactly one level
 * into each column's content. If you ever lift that restriction, this
 * helper needs to recurse further.
 */
export function findBlockInPage(
  page: NospressPageV2,
  blockId: string
): { block: Block; parent: Block[]; index: number } | null {
  const topIndex = page.blocks.findIndex(b => b.id === blockId);
  if (topIndex >= 0) {
    return { block: page.blocks[topIndex]!, parent: page.blocks, index: topIndex };
  }
  for (const tb of page.blocks) {
    if (tb.type !== 'columns') continue;
    for (const col of tb.content) {
      const idx = col.findIndex(b => b.id === blockId);
      if (idx >= 0) {
        return { block: col[idx]!, parent: col, index: idx };
      }
    }
  }
  return null;
}
