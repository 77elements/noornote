/**
 * Focus surface: Follows (v2).
 *
 * Same scoping pattern as the bookmarks/tribes surfaces: a FollowListManager
 * whose containerElement is the stage's column slot — the manager scopes
 * every internal query to the slot, so sorting, filtering and the extended
 * features work inside the shell. MainLayout's own manager instance is
 * untouched: the shell is a sibling of MainLayout.element, so the classic
 * instance's queries never see (or double-render) the surface DOM, and no
 * sync logic differs (docs/features/lists.md — zero changes in src/lists
 * sync behaviour).
 *
 * The content element mirrors the minimal classic tab DOM contract the
 * manager expects (`[data-tab-content="list-follows"]` with
 * `tab-content--active`) — that is what its refreshListIfActive() targets.
 *
 * The Extended Follows addon was MERGED into the follow list (v1 + v2
 * render the same list): mutuals, zap stats and follow verification are
 * always on — no settings panel, the object has no gear.
 */

import type { FocusDomainSurface } from './focusDomains';
import { createListTabSurface } from './focusListTabSurface';

export const followsSurface = (): Promise<FocusDomainSurface> =>
  createListTabSurface({
    tabId: 'list-follows',
    loadManager: async () =>
      (await import('../lists/follows')).FollowListManager,
  });
