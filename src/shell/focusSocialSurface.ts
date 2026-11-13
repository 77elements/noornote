/**
 * Focus surface: Social Media (v2).
 *
 * A FocusListDetailSurface wired to the social domain: the cached feed is
 * the classic TimelineView; note clicks arrive via the focusUiNavigation
 * seam (ViewNavigationController delegates here while the shell is
 * mounted) and the SingleNoteView renders INSIDE the column — the classic
 * SCC tab system does not exist in the shell. The URL follows along
 * (/timeline ↔ /note/:nevent) without touching the Router's view mounting.
 */

import type { FocusDomainSurface } from './focusDomains';
import { FocusListDetailSurface } from './focusListDetailSurface';

export const socialSurface = async (): Promise<FocusDomainSurface> => {
  const surface = new FocusListDetailSurface({
    className: 'focus-surface--social',
    navViewType: 'single-note',
    listRoute: '/timeline',
    detailRoute: nevent => `/note/${nevent}`,
    createList: async () => {
      const { TimelineView } = await import('../components/views/TimelineView');
      return new TimelineView();
    },
    createDetail: async nevent => {
      const { SingleNoteView } = await import(
        '../components/views/SingleNoteView'
      );
      return new SingleNoteView(nevent);
    },
    // The timeline manages its own internal scroll — no column-scroll
    // preservation needed around the swap.
  });
  return surface.asSurface();
};
