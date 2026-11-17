/**
 * Focus surface: Live Streams (v2).
 *
 * A FocusListDetailSurface wired to the live-streams addon domain: the
 * list is the classic LiveStreamsAddonView (enable + widget switches,
 * currently-live feed), clicking a stream swaps the classic
 * LiveStreamDetailView (inline player + "Play in background" pin)
 * INSIDE the surface. The URL follows along
 * (/live-streams ↔ /live-streams/stream/:naddr).
 *
 * Ephemeral (on-demand addon object): the stage destroys the surface
 * when the object closes — the list view's destroy releases the addon
 * runtime unless the sidebar widget or a background pin keeps it on.
 */

import type { FocusDomainSurface } from './focusDomains';
import { FocusListDetailSurface } from './focusListDetailSurface';

export const focusLiveStreamsSurface =
  async (): Promise<FocusDomainSurface> => {
    const surface = new FocusListDetailSurface({
      navViewType: 'live-stream-detail',
      listRoute: '/live-streams',
      detailRoute: naddr => `/live-streams/stream/${naddr}`,
      createList: async () => {
        const { LiveStreamsAddonView } = await import(
          '../addons/live-streams/LiveStreamsAddonView'
        );
        const view = new LiveStreamsAddonView();
        return {
          getElement: () => view.getElement(),
          destroy: () => view.destroy(),
        };
      },
      createDetail: async naddr => {
        const { LiveStreamDetailView } = await import(
          '../addons/live-streams/LiveStreamDetailView'
        );
        return new LiveStreamDetailView(naddr);
      },
    });
    return { ...surface.asSurface(), ephemeral: true };
  };
