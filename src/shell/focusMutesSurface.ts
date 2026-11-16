/**
 * Focus surface: Muted (v2).
 *
 * Same scoping pattern as the bookmarks/follows surfaces: a MuteListManager
 * whose containerElement is the SURFACE ROOT — the manager scopes every
 * internal query (classic tab container lookups, sync buttons, refreshes)
 * to the surface. MainLayout's own manager instance is untouched: the
 * shell is a sibling of MainLayout.element, so the classic instance's
 * queries never see (or double-render) the surface DOM, and no sync logic
 * differs (docs/features/lists.md — zero changes in src/lists sync
 * behaviour).
 *
 * The content element mirrors the minimal classic tab DOM contract the
 * manager expects (`[data-tab-content="list-mutes"]` with
 * `tab-content--active`) — that is what its refreshListIfActive() targets.
 */

import type { FocusDomainSurface } from './focusDomains';

export const mutesSurface = async (): Promise<FocusDomainSurface> => {
  const element = document.createElement('div');
  element.className = 'focus-surface focus-surface--mutes';

  const content = document.createElement('div');
  content.className = 'tab-content tab-content--active';
  content.dataset.tabContent = 'list-mutes';
  element.appendChild(content);

  const { MuteListManager } = await import('../lists/mutes');
  const manager = new MuteListManager(element);
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
