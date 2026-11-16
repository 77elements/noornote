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
    // The flat note composer (Write Note button → /timeline/new-note):
    // a param-less second detail in the same column; post/cancel return
    // to the timeline via the surface's back action.
    secondary: {
      navViewType: 'new-note',
      route: '/timeline/new-note',
      createDetail: async () => {
        const { NewNoteView } = await import('../components/views/NewNoteView');
        return new NewNoteView({ onClose: () => surface.back() });
      },
      // While the composer is open the gear's ED-b carries the composed
      // panel — custom emojis manager above the scheduled posts list
      // (both on-demand addons; dynamic import so the shell never
      // statically references addon code).
      settings: async () => {
        const [emojis, posts] = await Promise.all([
          import('../addons/custom-emojis/customEmojisPanel'),
          import('../addons/scheduled-posts/scheduledPostsSettings'),
        ]);
        const { composePanels } = await import('./focusSettings');
        return composePanels([
          emojis.createCustomEmojisSettings(),
          posts.createScheduledPostsSettings(),
        ]);
      },
    },
    // The timeline manages its own internal scroll — no column-scroll
    // preservation needed around the swap.
  });
  return surface.asSurface();
};
