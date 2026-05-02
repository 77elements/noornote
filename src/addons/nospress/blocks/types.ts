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
  | { id: string; type: 'heading'; level: 1 | 2 | 3; text: string; style?: CommonStyle }
  | { id: string; type: 'text'; content: string; style?: CommonStyle }
  | { id: string; type: 'image'; url: string; alt?: string; caption?: string; style?: CommonStyle }
  | { id: string; type: 'gallery'; urls: string[]; style?: CommonStyle }
  | { id: string; type: 'links'; title?: string; items: { label: string; url: string }[]; style?: CommonStyle }
  | { id: string; type: 'list'; title?: string; items: string[]; style?: CommonStyle }
  | { id: string; type: 'embed'; nostrRef: string; style?: CommonStyle }
  | { id: string; type: 'bookmark-folder'; folderName: string; style?: CommonStyle }
  | { id: string; type: 'columns'; count: 2 | 3; content: Block[][]; style?: CommonStyle }
  | { id: string; type: 'divider'; style?: CommonStyle }
  | { id: string; type: 'dm-button'; label: string; style?: CommonStyle }
  | { id: string; type: 'profile-card'; pubkey?: string; style?: CommonStyle }
  | { id: string; type: 'quote'; text: string; author?: string; source?: string; style?: CommonStyle }
  | { id: string; type: 'button-cta'; label: string; url: string; variant?: 'primary' | 'secondary'; style?: CommonStyle }
  | { id: string; type: 'video'; url: string; caption?: string; poster?: string; style?: CommonStyle }
  | { id: string; type: 'audio'; url: string; caption?: string; style?: CommonStyle }
  | { id: string; type: 'articles-list'; pubkey?: string; style?: CommonStyle }
  | { id: string; type: 'weblog'; pubkey?: string; hashtags?: string[]; postsPerPage?: number; excludeReplies?: boolean; excludeReposts?: boolean; style?: CommonStyle };

export type BlockType = Block['type'];

// CommonStyle / per-scope schema defined in `./styles.ts`.
import type { CommonStyle } from './styles';

export interface NospressPageV2 {
  version: 2;
  title?: string;
  subtitle?: string;
  description?: string;
  blocks: Block[];
  style?: CommonStyle;
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
    case 'profile-card':    return { id, type };
    case 'quote':           return { id, type, text: '' };
    case 'button-cta':      return { id, type, label: '', url: '' };
    case 'video':           return { id, type, url: '' };
    case 'audio':           return { id, type, url: '' };
    case 'articles-list':   return { id, type };
    case 'weblog':          return { id, type, hashtags: [] };
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
