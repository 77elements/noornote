/**
 * Session-scoped scroll memory for note threads (SingleNoteView).
 *
 * SNVs are NOT kept-alive: every navigation creates a fresh instance, so a
 * user who scrolls deep into a long reply thread, opens a reply far down and
 * comes back lands at the top again. This memory keeps the last scroll
 * offset per note id for the session so the fresh instance can restore it
 * after the thread has rendered.
 *
 * Deliberately session-only (no persistence): threads change between
 * sessions, a stale offset would be misleading.
 */

const MAX_ENTRIES = 50;

/** noteId → last observed scrollTop of the SNV's scroll container. */
const memory = new Map<string, number>();

/**
 * Remember `scrollTop` for `noteId`. Re-saving refreshes recency; the oldest
 * entry is evicted once the cap is exceeded so long browsing sessions don't
 * grow the map unboundedly.
 */
export function saveScrollPosition(noteId: string, scrollTop: number): void {
  if (!noteId) return;
  memory.delete(noteId);
  memory.set(noteId, scrollTop);
  while (memory.size > MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

/** Last saved offset for `noteId`, or undefined when none was saved. */
export function getScrollPosition(noteId: string): number | undefined {
  return memory.get(noteId);
}

/** Forget one note's offset — or the whole memory when no id is given. */
export function clearScrollPosition(noteId?: string): void {
  if (noteId === undefined) {
    memory.clear();
  } else {
    memory.delete(noteId);
  }
}

/**
 * Walk up from `el` and return the first ancestor that actually scrolls
 * vertically (overflow-y auto/scroll AND content overflows). Falls back to
 * the document scroller for window-scrolling layouts.
 *
 * Necessary because the SNV's scroll container varies by layout (classic
 * `.primary-content`, v2 focus column, window) — the view must not encode
 * layout specifics.
 */
export function findScrollableAncestor(el: HTMLElement | null): Element {
  let node = el?.parentElement ?? null;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (
      (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
}
