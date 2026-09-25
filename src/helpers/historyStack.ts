/**
 * Pure navigation-history helpers for the session-scoped back stack.
 *
 * The Router owns the stack (single source of truth); these helpers hold the
 * testable logic: aligning the stack index after native popstate navigation
 * and resolving a logical parent route when the stack is empty (cold deep link).
 */

/** Root views (sidebar/wheel destinations). Back has no logical parent there. */
const ROOT_PATHS: ReadonlySet<string> = new Set([
  '/',
  '/about',
  '/articles',
  '/marketplace',
  '/messages',
  '/notifications',
  '/settings',
  '/tribes',
  '/lists',
  '/addons',
]);

/**
 * Explicit parent mapping for detail/editor routes. First match wins.
 * Captures are substituted into the parent via `$1`.
 */
const ROUTE_PARENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/profile\/([^/]+)\/book$/, '/profile/$1'],
  [/^\/note\/.+$/, '/'],
  [/^\/article\/.+$/, '/'],
  [/^\/profile\/.+$/, '/'],
  [/^\/follow-pack\/.+$/, '/'],
  [/^\/zapstore\/.+$/, '/'],
  [/^\/reader\/.+$/, '/'],
  [/^\/relay\/.+$/, '/'],
  [/^\/listing\/.+$/, '/marketplace'],
  [/^\/write-listing(\/.*)?$/, '/marketplace'],
  [/^\/my-listings$/, '/marketplace'],
  [/^\/messages\/.+$/, '/messages'],
  [/^\/addons\/.+$/, '/addons'],
  [/^\/settings\/.+$/, '/settings'],
];

/** Normalize a path for comparison: strip query/hash and trailing slashes. */
export function normalizeRoutePath(path: string): string {
  const clean = (path.split('?')[0] ?? '').split('#')[0] ?? '';
  const trimmed = clean.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Align the stack index with the path the browser actually navigated to
 * (native Back/Forward fires popstate without touching the custom stack).
 * Returns the index of the LAST occurrence of the path, or the unchanged
 * currentIndex when the path is not on the stack (defensive).
 */
export function syncHistoryIndexToPath(
  history: string[],
  currentIndex: number,
  path: string
): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] === path) return i;
  }
  return currentIndex;
}

/**
 * Collapse runs of consecutive duplicate entries (every app reload re-pushes
 * the restored path — without this, Back would need one press per reload).
 * Returns the collapsed stack plus where the old index landed.
 */
export function collapseConsecutiveDuplicates(
  history: string[],
  index: number
): { history: string[]; index: number } {
  const out: string[] = [];
  const indexMap: number[] = [];
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (out.length === 0 || out[out.length - 1] !== entry) {
      out.push(entry as string);
    }
    indexMap.push(out.length - 1);
  }
  return { history: out, index: indexMap[index] ?? out.length - 1 };
}

/**
 * Logical parent for a path, used as Back fallback when the session stack is
 * empty (e.g. cold deep link straight onto a note). Root views return
 * themselves — "no parent" — so the caller can distinguish "exit app" from
 * "navigate up". Unknown paths fall back to '/'.
 */
export function resolveLogicalParent(path: string): string {
  if (!path) return '/';
  const clean = normalizeRoutePath(path);
  if (ROOT_PATHS.has(clean)) return clean;

  for (const [pattern, parent] of ROUTE_PARENTS) {
    const match = clean.match(pattern);
    if (match) {
      return match.length > 1
        ? parent.replace(/\$(\d)/g, (_, d) => match[Number(d)] ?? '')
        : parent;
    }
  }

  const firstSegment = `/${clean.split('/')[1] ?? ''}`;
  return ROOT_PATHS.has(firstSegment) ? firstSegment : '/';
}

/** Which kind of navigation is happening — drives the view-transition direction. */
export type NavigationKind = 'push' | 'back' | 'forward' | 'other';

/**
 * Classify a navigation for the view-transition layer. 'other' means "no
 * directional transition" (boot, force re-render, auth redirects) — the view
 * switches with a plain fade or none at all.
 */
export function resolveNavigationKind(opts: {
  isHistoryNavigation: boolean;
  historyDirection: 'back' | 'forward';
  skipHistory: boolean;
  force: boolean;
  samePath: boolean;
  isFirstNavigation: boolean;
}): NavigationKind {
  if (opts.isFirstNavigation) return 'other';
  if (opts.samePath && opts.force) return 'other';
  if (opts.isHistoryNavigation) return opts.historyDirection;
  if (opts.skipHistory) return 'other';
  return 'push';
}
