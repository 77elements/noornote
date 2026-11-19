/**
 * Focus surface factory: classic list-tab objects (v2).
 *
 * The bookmarks / follows / tribes / mutes surfaces are the same machine:
 * a classic list manager whose containerElement is the stage's column
 * slot — the manager scopes every internal query (classic tab container
 * lookups, folder grids, refreshes) to the slot. MainLayout's own manager
 * instance is untouched: the shell is a sibling of MainLayout.element, so
 * the classic instance's queries never see (or double-render) the surface
 * DOM, and no sync logic differs (docs/features/lists.md — zero changes
 * in src/lists sync behaviour).
 *
 * The content element mirrors the minimal classic tab DOM contract the
 * managers expect (`[data-tab-content="list-X"]` with
 * `tab-content--active`) — that is what their refresh*() and in-place
 * update paths target.
 *
 * Content stays CACHED across attach/detach (the manager instance is
 * preserved); view.destroy() tears the manager down and evicts the cache.
 */

import type { FocusDomainSurface } from './focusDomains';
import { createFocusViewHeader } from '../helpers/focusViewHeader';

/** Structural contract shared by the classic list managers. */
export interface FocusListTabManagerLike {
  renderListTab(container: HTMLElement): Promise<void> | void;
  destroy(): void;
}

type FocusListTabManagerCtor = new (
  container: HTMLElement
) => FocusListTabManagerLike;

export interface FocusListTabSurfaceConfig {
  /** Classic tab DOM contract id (`data-tab-content="…"`). */
  tabId: string;
  /**
   * Dynamic import → manager constructor, or null when the backing addon
   * is disabled (the empty state renders instead). The import stays in
   * the surface file — the factory never knows concrete list modules.
   */
  loadManager: () => Promise<FocusListTabManagerCtor | null>;
  /** Optional focus-view-header above the tab content (e.g. "Muted"). */
  headerTitle?: string;
  /** Shown instead of the tab content when loadManager resolves null. */
  emptyState?: {
    /** Root class of the fallback content element. */
    className: string;
    /** Inner markup of the fallback root (paragraph(s), wrapper divs). */
    innerHTML: string;
  };
}

export const createListTabSurface = (
  config: FocusListTabSurfaceConfig
): Promise<FocusDomainSurface> => {
  let manager: FocusListTabManagerLike | null = null;
  let header: HTMLElement | null = null;
  let content: HTMLElement | null = null;

  const buildEmptyState = (): HTMLElement => {
    const el = document.createElement('div');
    el.className = config.emptyState!.className;
    el.innerHTML = config.emptyState!.innerHTML;
    return el;
  };

  const buildContent = (slot: HTMLElement): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'tab-content tab-content--active';
    el.dataset.tabContent = config.tabId;
    slot.appendChild(el);
    return el;
  };

  return config.loadManager().then(Ctor => {
    return {
      attach(slot: HTMLElement): void {
        // Re-attach of the cached surface — hang the existing nodes back.
        if (header || content) {
          if (header) slot.appendChild(header);
          if (content) slot.appendChild(content);
          return;
        }
        if (!Ctor) {
          content = buildEmptyState();
          slot.appendChild(content);
          return;
        }
        if (config.headerTitle !== undefined) {
          header = createFocusViewHeader({ title: config.headerTitle });
          slot.appendChild(header);
        }
        content = buildContent(slot);
        manager = new Ctor(slot);
        void manager.renderListTab(content);
      },
      detach() {
        // Content stays cached — the manager instance is preserved.
        header?.remove();
        content?.remove();
      },
      view: {
        destroy(): void {
          manager?.destroy();
          manager = null;
          header = null;
          content = null;
        },
      },
    };
  });
};
