/**
 * Focus surface: Follows (v2).
 *
 * Same scoping pattern as the bookmarks/tribes surfaces: a FollowListManager
 * whose containerElement is the SURFACE ROOT — the manager scopes every
 * internal query to the surface, so sorting, filtering and the extended
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

export const followsSurface = async (): Promise<FocusDomainSurface> => {
  const element = document.createElement('div');
  element.className = 'focus-surface focus-surface--follows';

  const content = document.createElement('div');
  content.className = 'tab-content tab-content--active';
  content.dataset.tabContent = 'list-follows';
  element.appendChild(content);

  const { FollowListManager } = await import('../lists/follows');
  const manager = new FollowListManager(element);
  await manager.renderListTab(content);

  return {
    element,
    view: {
      destroy(): void {
        manager.destroy();
        element.innerHTML = '';
      },
    },
  };
};
