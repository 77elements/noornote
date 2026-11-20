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
import { createListTabSurface } from './focusListTabSurface';
import { _ } from '../i18n';

export const bookmarksSurface = (): Promise<FocusDomainSurface> =>
  createListTabSurface({
    tabId: 'list-bookmarks',
    loadManager: async () => {
      const { isBookmarksEnabled } = await import('../addons/bookmarks/index');
      return isBookmarksEnabled()
        ? (await import('../lists/bookmarks')).BookmarkManager
        : null;
    },
    emptyState: {
      className: 'view-content view-content--lists',
      innerHTML: `<div class="bookmarks-empty-state"><p>${_('Enable Bookmarks in Settings.')}</p></div>`,
    },
  });
