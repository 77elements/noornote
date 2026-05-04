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

/**
 * HTML-attribute overrides on a block's outer wrapper (NOT a CSS-property
 * payload — semantically different from `style`). Lets the user target a
 * specific block from `customCss` via a class or id selector. Sanitized at
 * render time in `styleWrap()`.
 */
export interface BlockAttrs {
  class?: string;
  id?: string;
}

export type Block =
  | { id: string; type: 'heading'; level: 1 | 2 | 3; text: string; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'text'; content: string; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'image'; url: string; alt?: string; caption?: string; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'gallery'; urls: string[]; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'links'; title?: string; items: { label: string; url: string }[]; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'list'; title?: string; items: string[]; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'embed'; nostrRef: string; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'bookmark-folder'; folderName: string; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'columns'; count: 2 | 3; content: Block[][]; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'divider'; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'dm-button'; label: string; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'profile-card'; pubkey?: string; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'quote'; text: string; author?: string; source?: string; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'button-cta'; label: string; url: string; variant?: 'primary' | 'secondary'; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'video'; url: string; caption?: string; poster?: string; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'audio'; url: string; caption?: string; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'articles-list'; pubkey?: string; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'weblog'; pubkey?: string; hashtags?: string[]; postsPerPage?: number; excludeReplies?: boolean; excludeReposts?: boolean; style?: CommonStyle; attrs?: BlockAttrs }
  | { id: string; type: 'div'; tag: DivTag; content?: string; style?: CommonStyle; attrs?: BlockAttrs };

/** Allowed semantic block-level HTML elements for the generic `div` block. */
export const DIV_TAGS = ['div', 'header', 'footer', 'main', 'section', 'article', 'aside', 'nav', 'fieldset'] as const;
export type DivTag = typeof DIV_TAGS[number];

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
  /** Raw user CSS, scoped to `.user-site` at apply time via `cssScope.ts`.
   *  Persisted with the rest of the page — same NIP-78 event content. */
  customCss?: string;
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
    case 'div':             return { id, type, tag: 'div' };
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
