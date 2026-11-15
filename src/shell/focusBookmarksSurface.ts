/**
 * Focus surface: Bookmarks (v2).
 *
 * The column renders a BookmarkManager whose containerElement is the
 * SURFACE ROOT — the manager scopes every internal query (classic tab
 * container lookups, folder grid, card states) to the surface, so folder
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
import { _ } from '../i18n';

export const bookmarksSurface = async (): Promise<FocusDomainSurface> => {
  const element = document.createElement('div');
  element.className = 'focus-surface focus-surface--bookmarks';

  const { isBookmarksEnabled } = await import('../addons/bookmarks/index');
  if (!isBookmarksEnabled()) {
    element.innerHTML = `
      <div class="view-content view-content--lists">
        <div class="bookmarks-empty-state">
          <p>${_('Enable the Bookmarks addon in Settings → Addons.')}</p>
        </div>
      </div>
    `;
    return { element };
  }

  const { BookmarkManager } = await import('../lists/bookmarks');
  const manager = new BookmarkManager(element);

  const content = document.createElement('div');
  content.className = 'tab-content tab-content--active';
  content.dataset.tabContent = 'list-bookmarks';
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
