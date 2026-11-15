/**
 * Infinite-scroll refill decision (pure logic, no imports).
 *
 * Background: the IntersectionObserver behind infinite scroll only fires on
 * intersection TRANSITIONS. A load that appends too few notes to push the
 * sentinel out of view leaves the intersection state unchanged — no new event
 * fires, and the feed deadlocks below a short first screen. The fix has two
 * halves:
 *
 * 1. Re-evaluate the sentinel after every completed load (DOM side, see
 *    InfiniteScroll.revalidate) — a still-visible sentinel re-triggers.
 * 2. Bound the re-triggering when loads stop yielding NEW events: if every
 *    fetched event was already loaded, the until-cursor (oldest loaded event)
 *    does not advance, so the next load would repeat the identical query
 *    forever. After MAX_EMPTY_LOAD_STREAK consecutive zero-new-results loads,
 *    hasMore latches false and the user keeps what they have.
 */

export const MAX_EMPTY_LOAD_STREAK = 3;

/**
 * Whether a completed loadMore with zero NEW (non-duplicate) events should
 * latch the feed terminal. `streak` counts consecutive empty-result loads.
 */
export function shouldLatchTerminalAfterEmptyStreak(streak: number): boolean {
  return streak >= MAX_EMPTY_LOAD_STREAK;
}
