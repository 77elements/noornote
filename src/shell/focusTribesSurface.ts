/**
 * Focus surface: Tribes (v2).
 *
 * Same scoping pattern as the bookmarks surface: a TribeManager whose
 * containerElement is the SURFACE ROOT — the manager scopes every
 * internal query to the surface, so folder navigation and member
 * management work inside the shell. MainLayout's own manager instance is
 * untouched: the shell is a sibling of MainLayout.element, so the classic
 * instance's queries never see (or double-render) the surface DOM, and no
 * sync logic differs (docs/features/lists.md — zero changes in src/lists
 * sync behaviour).
 *
 * The content element mirrors the minimal classic tab DOM contract the
 * manager expects (`[data-tab-content="list-tribes"]` with
 * `tab-content--active`) — that is what its refreshIfActive() and its
 * event-driven refreshes (tribe:updated, list-sync-mode:changed) target.
 *
 * Tribes are ALWAYS ON: no addon gate, no settings panel (the object has
 * no gear). Every change emits `tribe:updated` — the TV tab row in the
 * social surface rebuilds on it, the "Edit tribes" link routes here via
 * the focus navigation seam.
 */

import type { FocusDomainSurface } from './focusDomains';

export const tribesSurface = async (): Promise<FocusDomainSurface> => {
  const element = document.createElement('div');
  element.className = 'focus-surface focus-surface--tribes';

  const { TribeManager } = await import('../lists/tribes');
  const manager = new TribeManager(element);

  const content = document.createElement('div');
  content.className = 'tab-content tab-content--active';
  content.dataset.tabContent = 'list-tribes';
  element.appendChild(content);

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
