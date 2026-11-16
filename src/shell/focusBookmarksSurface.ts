/**
 * Focus surface: Bookmarks (v2).
 *
 * The column renders a BookmarkManager whose containerElement is the
 * stage's column slot — the manager scopes every internal query (classic
 * tab container lookups, folder grid, card states) to the slot, so folder
 * navigation, mark-as-read and event-driven refreshes work inside the
 * shell. MainLayout's own manager instance is untouched: the shell is a
 * sibling of MainLayout.element, so the classic instance's queries never
 * see (or double-render) the surface DOM, and no sync logic differs
 * (docs/features/lists.md — zero changes in src/lists sync behaviour).
 *
 * The content element mirrors the minimal classic tab DOM contract the
 * manager expects (`[data-tab-content="list-bookmarks"]` with
 * `tab-content--active`) — that is what its refreshIfActive() and
 * in-place read-state updates target.
 *
 * The list owns no detail view — clicking a bookmarked note routes
 * through the focus navigation seam (BookmarkCard uses openView) to the
 * owning object (social → SNV, articles → AV).
 */

import type { FocusDomainSurface } from './focusDomains';
import type { BookmarkManager } from '../lists/bookmarks';
import { _ } from '../i18n';

export const bookmarksSurface = async (): Promise<FocusDomainSurface> => {
  const { isBookmarksEnabled } = await import('../addons/bookmarks/index');
  const BookmarkManagerCtor = isBookmarksEnabled()
    ? (await import('../lists/bookmarks')).BookmarkManager
    : null;

  let manager: BookmarkManager | null = null;
  let content: HTMLElement | null = null;

  return {
    attach(slot) {
      if (content) {
        slot.appendChild(content);
        return;
      }
      if (!BookmarkManagerCtor) {
        content = document.createElement('div');
        content.className = 'view-content view-content--lists';
        content.innerHTML = `
          <div class="bookmarks-empty-state">
            <p>${_('Enable the Bookmarks addon in Settings → Addons.')}</p>
          </div>
        `;
        slot.appendChild(content);
        return;
      }
      content = document.createElement('div');
      content.className = 'tab-content tab-content--active';
      content.dataset.tabContent = 'list-bookmarks';
      slot.appendChild(content);
      manager = new BookmarkManagerCtor(slot);
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
