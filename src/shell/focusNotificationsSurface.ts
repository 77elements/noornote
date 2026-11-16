/**
 * Focus surface: Notifications (v2).
 *
 * A FocusListDetailSurface wired to the notifications domain: the cached
 * list is the classic NotificationsView; clicking a notification swaps
 * the classic SingleNoteView INSIDE the column — the classic SCC tab
 * system does not exist in the shell. The URL follows along
 * (/notifications ↔ /note/:nevent) without touching the Router's view
 * mounting. Article-type notifications route cross-object to the
 * articles domain (viewTypes seam), same as in the social surface.
 */

import type { FocusDomainSurface } from './focusDomains';
import { FocusListDetailSurface } from './focusListDetailSurface';

export const notificationsSurface = async (): Promise<FocusDomainSurface> => {
  const surface = new FocusListDetailSurface({
    navViewType: 'single-note',
    listRoute: '/notifications',
    detailRoute: nevent => `/note/${nevent}`,
    createList: async () => {
      const { NotificationsView } = await import(
        '../components/views/NotificationsView'
      );
      return new NotificationsView();
    },
    createDetail: async nevent => {
      const { SingleNoteView } = await import(
        '../components/views/SingleNoteView'
      );
      return new SingleNoteView(nevent);
    },
    // The list view has no internal scroll — the column scrolls, so the
    // feed position survives the list ↔ detail swap.
    preserveListScroll: true,
  });
  return surface.asSurface();
};
