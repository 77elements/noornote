/**
 * Focus surface: Tribes (v2).
 *
 * Same scoping pattern as the bookmarks surface: a TribeManager whose
 * containerElement is the stage's column slot — the manager scopes every
 * internal query to the slot, so folder navigation and member management
 * work inside the shell. MainLayout's own manager instance is untouched:
 * the shell is a sibling of MainLayout.element, so the classic instance's
 * queries never see (or double-render) the surface DOM, and no sync logic
 * differs (docs/features/lists.md — zero changes in src/lists sync
 * behaviour).
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
  const { TribeManager } = await import('../lists/tribes');
  let manager: InstanceType<typeof TribeManager> | null = null;
  let content: HTMLElement | null = null;

  return {
    attach(slot) {
      if (content) {
        slot.appendChild(content);
        return;
      }
      content = document.createElement('div');
      content.className = 'tab-content tab-content--active';
      content.dataset.tabContent = 'list-tribes';
      slot.appendChild(content);
      manager = new TribeManager(slot);
      void manager.renderListTab(content);
    },
    detach() {
      // Content stays cached — the manager instance is preserved.
      content?.remove();
    },
    view: {
      destroy(): void {
        manager?.destroy();
        manager = null;
        content = null;
      },
    },
  };
};
