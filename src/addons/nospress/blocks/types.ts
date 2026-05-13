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
  | { id: string; type: 'heading'; level: 1 | 2 | 3; text: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'text'; content: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'image'; url: string; alt?: string; caption?: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'gallery'; urls: string[]; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'links'; title?: string; items: { label: string; url: string }[]; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'list'; title?: string; items: string[]; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'embed'; nostrRef: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'bookmark-folder'; folderName: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'columns'; layout: number[]; content: Block[][]; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'divider'; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'dm-button'; label: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'profile-card'; pubkey?: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'quote'; text: string; author?: string; source?: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'button-cta'; label: string; url: string; variant?: 'primary' | 'secondary'; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'video'; url: string; caption?: string; poster?: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'audio'; url: string; caption?: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'articles-list'; pubkey?: string; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'weblog'; pubkey?: string; hashtags?: string[]; includeWithoutHash?: boolean; postsPerPage?: number; excludeReplies?: boolean; excludeReposts?: boolean; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'div'; tag: DivTag; children: Block[]; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'nav-menu'; menuId: string; horizontal?: boolean; alignment?: 'left' | 'center' | 'right'; hamburgerBreakpoints?: string[]; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs }
  | { id: string; type: 'portfolio'; projects: PortfolioProject[]; perPage?: number; sortOrder?: PortfolioSortOrder; style?: CommonStyle; breakpointStyles?: Record<string, CommonStyle>; attrs?: BlockAttrs };

/** Project sort modes:
 *   - `manual`  → use the drag-order the editor maintains in `projects[]`
 *   - `newest`  → newest `date` first (missing dates sink to the end)
 *   - `oldest`  → oldest `date` first (missing dates sink to the end)
 *  Default = `'manual'` so existing portfolios render unchanged. */
export type PortfolioSortOrder = 'manual' | 'newest' | 'oldest';

/** One project entry inside a `portfolio` block. `screenshots[0]` is the
 *  hero shown in the collapsed card; clicking the card expands it inline
 *  to reveal the full screenshot list in a horizontal carousel.
 *  `id` is generated client-side (UUID) so editor reorders + per-project
 *  expand state survive across re-renders. `date` is ISO (`YYYY-MM` or
 *  `YYYY-MM-DD`) — sortable as a plain string and locale-agnostic. */
export interface PortfolioProject {
  id: string;
  title: string;
  description?: string;
  link?: string;
  date?: string;
  screenshots: string[];
}

/** Allowed semantic block-level HTML elements for the generic `div` block. */
export const DIV_TAGS = ['div', 'header', 'footer', 'main', 'section', 'article', 'aside', 'nav', 'fieldset'] as const;
export type DivTag = typeof DIV_TAGS[number];

export type BlockType = Block['type'];

// CommonStyle / per-scope schema defined in `./styles.ts`.
import type { CommonStyle } from './styles';
import { PRIMARY_MENU_ID } from './menu';

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
    case 'heading':         return { id, type, level: 2, text: '', style: { color: 'var(--color-5)' } };
    case 'text':            return { id, type, content: '', style: { color: 'var(--color-5)' } };
    case 'image':           return { id, type, url: '' };
    case 'gallery':         return { id, type, urls: [] };
    case 'links':           return { id, type, items: [] };
    case 'list':            return { id, type, items: [] };
    case 'embed':           return { id, type, nostrRef: '' };
    case 'bookmark-folder': return { id, type, folderName: '' };
    case 'columns':         return { id, type, layout: [1, 1], content: [[], []] };
    case 'divider':         return { id, type };
    case 'dm-button':       return { id, type, label: 'Send me a message' };
    case 'profile-card':    return { id, type };
    case 'quote':           return { id, type, text: '' };
    case 'button-cta':      return { id, type, label: '', url: '' };
    case 'video':           return { id, type, url: '' };
    case 'audio':           return { id, type, url: '' };
    case 'articles-list':   return { id, type };
    case 'weblog':          return { id, type, hashtags: [] };
    case 'div':             return { id, type, tag: 'div', children: [] };
    case 'nav-menu':        return { id, type, menuId: PRIMARY_MENU_ID };
    case 'portfolio':       return { id, type, projects: [] };
  }
}

/**
 * Deep-clone a block, regenerating every `id` field encountered along the
 * way (the root block + every nested block inside `columns.content[][]`
 * and `div.children[]`). Used by the editor's copy/paste action so a
 * pasted block never collides with the original's DOM keys when both
 * sit on the same page.
 *
 * Sub-arrays like `portfolio.projects[*].id` carry their own UUIDs for
 * editor reorder + per-project expand state, which must also be reset
 * — otherwise two portfolios would map to the same expand-state slot.
 */
export function cloneBlockWithFreshIds(block: Block): Block {
  const copy = JSON.parse(JSON.stringify(block)) as Block;
  resetBlockIds(copy);
  return copy;
}

function resetBlockIds(block: Block): void {
  block.id = newId();
  if (block.type === 'columns') {
    for (const col of block.content) for (const b of col) resetBlockIds(b);
  } else if (block.type === 'div') {
    for (const b of block.children) resetBlockIds(b);
  } else if (block.type === 'portfolio') {
    for (const p of block.projects) p.id = newId();
  }
}

/**
 * Strip a block of its user-entered content while keeping every
 * presentation property intact. Used when saving a multi-block selection
 * as a reusable Custom Block template — the layout, styling and per-block
 * configuration round-trip; only the "what's written in this slot" half
 * is reset so the user re-fills it on each insert.
 *
 * Preserved across the board: `style`, `breakpointStyles`, `attrs`.
 *
 * Per-type rules for what counts as "content" vs "configuration":
 *
 *   heading       → text reset (level kept — it's structural)
 *   text          → content reset
 *   image / video → url, caption, alt, poster reset
 *   audio         → url, caption reset
 *   gallery       → urls reset
 *   links / list  → title + items reset
 *   embed         → nostrRef reset
 *   bookmark-folder, profile-card, articles-list → folderName / pubkey reset
 *   quote         → text, author, source reset
 *   button-cta    → label, url reset (variant kept — picker pre-selects)
 *   dm-button     → label reset
 *   weblog        → pubkey, hashtags reset; postsPerPage / includeWithoutHash
 *                   / excludeReplies / excludeReposts kept (behaviour switches)
 *   portfolio     → projects[] reset; perPage / sortOrder kept
 *   nav-menu      → ALL fields kept (menuId / horizontal / alignment /
 *                   hamburgerBreakpoints are all configuration)
 *   columns / div → recurse into children, layout / tag kept
 *   divider       → nothing to reset (no content field)
 *
 * Pure (deep-clones first; never touches the input tree).
 */
export function stripBlockContent(block: Block): Block {
  const fresh = JSON.parse(JSON.stringify(block)) as Block;
  switch (fresh.type) {
    case 'heading':         fresh.text = ''; break;
    case 'text':            fresh.content = ''; break;
    case 'image':
      fresh.url = '';
      delete fresh.alt;
      delete fresh.caption;
      break;
    case 'gallery':         fresh.urls = []; break;
    case 'links':
      delete fresh.title;
      fresh.items = [];
      break;
    case 'list':
      delete fresh.title;
      fresh.items = [];
      break;
    case 'embed':           fresh.nostrRef = ''; break;
    case 'bookmark-folder': fresh.folderName = ''; break;
    case 'dm-button':       fresh.label = ''; break;
    case 'profile-card':    delete fresh.pubkey; break;
    case 'quote':
      fresh.text = '';
      delete fresh.author;
      delete fresh.source;
      break;
    case 'button-cta':
      fresh.label = '';
      fresh.url = '';
      break;
    case 'video':
      fresh.url = '';
      delete fresh.caption;
      delete fresh.poster;
      break;
    case 'audio':
      fresh.url = '';
      delete fresh.caption;
      break;
    case 'articles-list':   delete fresh.pubkey; break;
    case 'weblog':
      delete fresh.pubkey;
      delete fresh.hashtags;
      // postsPerPage, excludeReplies, excludeReposts kept (behaviour)
      break;
    case 'columns':
      fresh.content = fresh.content.map(col => col.map(stripBlockContent));
      break;
    case 'div':
      fresh.children = fresh.children.map(stripBlockContent);
      break;
    case 'portfolio':
      fresh.projects = [];
      // perPage, sortOrder kept (display behaviour)
      break;
    case 'nav-menu':
    case 'divider':
      // No content slot — pure config / no content.
      break;
  }
  return fresh;
}

/**
 * Filter a flat list of block locations down to those that are NOT
 * contained inside any other block in the same list. Used by the
 * "group as custom block" / "copy group" actions so a multi-selection
 * like `[columns, image-inside-columns]` doesn't end up storing the
 * image twice (once in columns.content, once at the group root).
 */
export function topLevelOnly(blocks: Block[]): Block[] {
  const ids = new Set(blocks.map(b => b.id));
  return blocks.filter(b => !blocks.some(other => other.id !== b.id && containsBlockId(other, b.id, ids)));
}

function containsBlockId(parent: Block, childId: string, _seen: Set<string>): boolean {
  if (parent.type === 'columns') {
    return parent.content.some(col => col.some(b => b.id === childId || containsBlockId(b, childId, _seen)));
  }
  if (parent.type === 'div') {
    return parent.children.some(b => b.id === childId || containsBlockId(b, childId, _seen));
  }
  return false;
}

/** Where a block sits in the page tree. `container` is undefined when the
 *  block lives directly on the page; otherwise it points back at the owning
 *  container so callers can derive the cursor scope without re-walking. */
export interface BlockLocation {
  block: Block;
  parent: Block[];
  index: number;
  container?:
    | { type: 'column'; block: Extract<Block, { type: 'columns' }>; colIndex: number }
    | { type: 'div'; block: Extract<Block, { type: 'div' }> };
}

/**
 * Locate a block by id anywhere in the page tree. Recurses fully, so a
 * block inside a `columns` block that itself sits inside a `div` is
 * findable. Returns the block + its parent array + index for splice/move,
 * plus a `container` hint that callers use to map back to a cursor scope.
 *
 * Allowed nesting (enforced at insert time, not here):
 *   - div lives only at page level
 *   - columns lives at page level OR inside a div
 *   - columns cannot live inside another columns
 */
export function findBlockInPage(page: NospressPageV2, blockId: string): BlockLocation | null {
  return findInArray(page.blocks, blockId, undefined);
}

/**
 * Available column-layout presets shown in the picker modal. Each entry
 * is a ratio array — the renderer maps it to `grid-template-columns:
 * <r1>fr <r2>fr ...`. Order matters: it's the order the picker renders
 * the cards in (grouped by column count, asymmetrics last).
 */
export const COLUMN_LAYOUT_PRESETS: number[][] = [
  // 2 columns
  [1, 1],
  [1, 2],
  [2, 1],
  [1, 3],
  [3, 1],
  [2, 3],
  [3, 2],
  // 3 columns
  [1, 1, 1],
  [1, 1, 2],
  [2, 1, 1],
  [1, 2, 1],
  [1, 3, 1],
  // 4 columns
  [1, 1, 1, 1],
  [1, 1, 1, 2],
  [2, 1, 1, 1],
  [1, 2, 1, 1],
  [1, 1, 2, 1],
  // 5 / 6 columns
  [1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1],
];

/**
 * In-place migration: legacy `columns` blocks stored `count: 2 | 3` and
 * implicitly equal-width columns. New shape uses `layout: number[]` as
 * the single source of truth. Walk every block recursively (columns can
 * sit inside `div`, and divs can nest), so that deep pages don't slip
 * past unconverted.
 *
 * Idempotent: pages that already have `layout` are left alone.
 */
export function normalizePage(page: NospressPageV2): NospressPageV2 {
  normalizeBlocks(page.blocks);
  return page;
}

function normalizeBlocks(blocks: Block[]): void {
  for (const b of blocks) {
    // Default text-color: heading + text blocks fall back to the
    // palette's text slot (`var(--color-5)`) when the user hasn't picked
    // one. Applied here so old drafts written before the default landed
    // get the same look as freshly-created blocks. Idempotent — only
    // fills when the slot is missing.
    if (b.type === 'heading' || b.type === 'text') {
      if (!b.style) b.style = {};
      if (b.style.color === undefined) b.style.color = 'var(--color-5)';
    }
    if (b.type === 'columns') {
      const legacy = b as unknown as { count?: number; layout?: number[] };
      if (!Array.isArray(legacy.layout) || legacy.layout.length === 0) {
        const fallback = legacy.count === 3 ? 3 : Math.max(2, b.content?.length ?? 2);
        legacy.layout = Array.from({ length: fallback }, () => 1);
      }
      // Align content array length with layout — defensive: an old page
      // could have layout=[1,1,1] but only 2 content arrays, or vice versa.
      while (b.content.length < b.layout.length) b.content.push([]);
      if (b.content.length > b.layout.length) {
        const survivor = b.content[b.layout.length - 1] ?? [];
        for (let i = b.layout.length; i < b.content.length; i++) {
          survivor.push(...(b.content[i] ?? []));
        }
        b.content[b.layout.length - 1] = survivor;
        b.content.length = b.layout.length;
      }
      // Drop the legacy field so JSON.stringify doesn't keep emitting it.
      delete legacy.count;
      // Recurse into nested blocks per column.
      for (const col of b.content) normalizeBlocks(col);
    } else if (b.type === 'div') {
      normalizeBlocks(b.children);
    }
  }
}

function findInArray(
  arr: Block[],
  blockId: string,
  container: BlockLocation['container']
): BlockLocation | null {
  const idx = arr.findIndex(b => b.id === blockId);
  if (idx >= 0) {
    const loc: BlockLocation = { block: arr[idx]!, parent: arr, index: idx };
    if (container) loc.container = container;
    return loc;
  }
  for (const b of arr) {
    if (b.type === 'columns') {
      for (let c = 0; c < b.content.length; c++) {
        const col = b.content[c]!;
        const found = findInArray(col, blockId, { type: 'column', block: b, colIndex: c });
        if (found) return found;
      }
    } else if (b.type === 'div') {
      const found = findInArray(b.children, blockId, { type: 'div', block: b });
      if (found) return found;
    }
  }
  return null;
}
