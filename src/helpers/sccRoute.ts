/**
 * Canonical mapping between scc view-tab types and their route paths.
 *
 * Single source of truth for: the Router path of a view, and the `?scc=` URL
 * parameter that persists the active secondary-pane (scc) view across reloads
 * in right-pane mode. Keep both directions in sync when adding a new ViewType.
 */

import type { ViewType } from '../services/ViewNavigationController';

/** View type + param → route path (e.g. ('profile', 'npub1…') → '/profile/npub1…'). */
export function viewTypeToPath(viewType: ViewType, param?: string): string {
  switch (viewType) {
    case 'single-note':
      return `/note/${param}`;
    case 'article':
      return `/article/${param}`;
    case 'follow-pack':
      return `/follow-pack/${param}`;
    case 'profile':
      return `/profile/${param}`;
    case 'notifications':
      return '/notifications';
    case 'messages':
      return '/messages';
    default:
      return '/';
  }
}

/** The four list types that can occupy the scc, encoded as `list-<type>`. */
const LIST_TYPES = ['follows', 'bookmarks', 'mutes', 'tribes'];

/** Parsed `?scc=` value: a view route, a list, or a search term. */
export type ParsedScc =
  | { kind: 'view'; viewType: ViewType; param?: string }
  | { kind: 'list'; listType: string }
  | { kind: 'search'; term: string };

/** Decode a `?scc=` value into the scc content it represents (or null if unknown). */
export function parseSccParam(value: string): ParsedScc | null {
  if (value.startsWith('/')) {
    const view = pathToView(value);
    if (!view) return null;
    return { kind: 'view', viewType: view.viewType, ...(view.param !== undefined && { param: view.param }) };
  }
  if (value.startsWith('list-')) {
    const listType = value.slice('list-'.length);
    return LIST_TYPES.includes(listType) ? { kind: 'list', listType } : null;
  }
  if (value.startsWith('search:')) {
    const term = value.slice('search:'.length);
    return term ? { kind: 'search', term } : null;
  }
  return null;
}

/** Read the current `?scc=` value from the URL, or null. */
export function readSccParam(): string | null {
  return new URLSearchParams(window.location.search).get('scc');
}

/**
 * Write (or clear) the `?scc=` query param while preserving the pcc path and any
 * other query params. Uses replaceState so scc changes don't pollute history.
 */
export function writeSccParam(value: string | null): void {
  const params = new URLSearchParams(window.location.search);
  if (value) {
    params.set('scc', value);
  } else {
    params.delete('scc');
  }
  const qs = params.toString();
  const url = window.location.pathname + (qs ? `?${qs}` : '');
  window.history.replaceState(window.history.state, '', url);
}

/** Route path → view type + param, or null if the path is not a restorable scc view. */
export function pathToView(path: string): { viewType: ViewType; param?: string } | null {
  const segments = path.replace(/^\//, '').split('/');
  switch (segments[0]) {
    case 'note':
      return segments[1] ? { viewType: 'single-note', param: segments[1] } : null;
    case 'article':
      return segments[1] ? { viewType: 'article', param: segments[1] } : null;
    case 'follow-pack':
      return segments[1] ? { viewType: 'follow-pack', param: segments[1] } : null;
    case 'profile':
      return segments[1] ? { viewType: 'profile', param: segments[1] } : null;
    case 'notifications':
      return { viewType: 'notifications' };
    case 'messages':
      return { viewType: 'messages' };
    default:
      return null;
  }
}
