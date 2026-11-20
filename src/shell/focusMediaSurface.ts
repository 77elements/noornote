/**
 * Focus surface: Media (v2).
 *
 * A FocusListDetailSurface wired to the media domain: the cached list is
 * the classic SCC media feed (SccMediaFeed) — the same masonry of the
 * follows' photo/video notes (kinds 20/21/22), same batching and
 * infinite scroll. The only seam difference: tile clicks route through
 * the focus nav (openView('single-note')) so the SNV opens in the social
 * object (cross-object morph) instead of a classic router navigation.
 *
 * The surface has NO primary detail of its own — the note detail belongs
 * to the social domain. Its only detail is the secondary composer
 * (VideoEditorView at /media/post), opened by the header's Post button
 * via the focus navigation seam; back/publish return to the list.
 */

import type { FocusDomainSurface } from './focusDomains';
import { FocusListDetailSurface } from './focusListDetailSurface';
import { createFocusViewHeader } from '../helpers/focusViewHeader';
import { _ } from '../i18n';

export const mediaSurface = async (): Promise<FocusDomainSurface> => {
  const surface = new FocusListDetailSurface({
    listRoute: '/media',
    createList: async () => {
      const { SccMediaFeed } = await import(
        '../components/layout/partials/SccMediaFeed'
      );
      const { encodeNevent } = await import('../services/NostrToolsAdapter');
      const { getViewNavigationController } = await import(
        '../services/ViewNavigationController'
      );

      // Header: the bare h1 (Post Media lives in the stack's primary
      // action row). The feed appends its .media-feed directly as the
      // body grid's second row — no extra wrapper.
      const root = document.createElement('div');
      root.className = 'media-surface__body';
      root.appendChild(
        createFocusViewHeader({ title: _('Media'), object: 'media' })
      );

      const feed = new SccMediaFeed(root, {
        onClick: (event, clickEvent) => {
          if (!event.id) return;
          const nevent = encodeNevent(event.id);
          getViewNavigationController().openView(
            'single-note',
            nevent,
            clickEvent
          );
        },
      });

      return {
        getElement: () => root,
        destroy: () => feed.destroy(),
      };
    },
    // The video composer (Post button → /media/post): a param-less
    // secondary detail in the same column; back/publish return to the
    // media list via the surface's back action.
    secondary: {
      navViewType: 'write-video',
      route: '/media/post',
      createDetail: async () => {
        const { VideoEditorView } = await import(
          '../components/views/VideoEditorView'
        );
        return new VideoEditorView({ onClose: () => surface.back() });
      },
    },
  });
  return surface.asSurface();
};
