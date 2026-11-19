/**
 * Focus surface: Muted (v2).
 *
 * Same scoping pattern as the bookmarks/follows surfaces: a MuteListManager
 * whose containerElement is the stage's column slot — the manager scopes
 * every internal query (classic tab container lookups, sync buttons,
 * refreshes) to the slot. MainLayout's own manager instance is untouched:
 * the shell is a sibling of MainLayout.element, so the classic instance's
 * queries never see (or double-render) the surface DOM, and no sync logic
 * differs (docs/features/lists.md — zero changes in src/lists sync
 * behaviour).
 *
 * The content element mirrors the minimal classic tab DOM contract the
 * manager expects (`[data-tab-content="list-mutes"]` with
 * `tab-content--active`) — that is what its refreshListIfActive() targets.
 */

import type { FocusDomainSurface } from './focusDomains';
import { createListTabSurface } from './focusListTabSurface';
import { _ } from '../i18n';

export const mutesSurface = (): Promise<FocusDomainSurface> =>
  createListTabSurface({
    tabId: 'list-mutes',
    headerTitle: _('Muted'),
    loadManager: async () => (await import('../lists/mutes')).MuteListManager,
  });
