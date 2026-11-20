/**
 * Focus surface: Marketplace (v2).
 *
 * A FocusListDetailSurface wired to the marketplace addon domain: the
 * cached list is the classic MarketplaceView (MarketplaceTimeline),
 * clicking a listing swaps the classic ListingView INSIDE the surface.
 * The URL follows along (/marketplace ↔ /listing/:naddr) without touching
 * the Router's view mounting.
 *
 * The addon runtime is a no-op (see runtime.ts) — the surface is cached,
 * not ephemeral.
 */

import type { FocusDomainSurface } from './focusDomains';
import { FocusListDetailSurface } from './focusListDetailSurface';
import { createFocusViewHeader } from '../helpers/focusViewHeader';
import { _ } from '../i18n';

export const marketplaceSurface = async (): Promise<FocusDomainSurface> => {
  const surface = new FocusListDetailSurface({
    navViewType: 'listing',
    listRoute: '/marketplace',
    detailRoute: naddr =>
      // 'my-listings' is the dashboard (/my-listings — the "My Listings"
      // button in the marketplace header navigates the classic route).
      naddr === 'my-listings' ? '/my-listings' : `/listing/${naddr}`,
    createList: async () => {
      const { MarketplaceView } = await import(
        '../addons/marketplace/MarketplaceView'
      );
      const view = new MarketplaceView();

      // Header: the bare h1 (Post Listing lives in the stack's primary
      // action row).
      view.getElement().prepend(
        createFocusViewHeader({
          title: _('Marketplace'),
          object: 'marketplace',
        })
      );

      return {
        getElement: () => view.getElement(),
        destroy: () => view.destroy(),
      };
    },
    createDetail: async naddr => {
      if (naddr === 'my-listings') {
        const { MyListingsView } = await import(
          '../addons/marketplace/MyListingsView'
        );
        return new MyListingsView();
      }
      const { ListingView } = await import('../addons/marketplace/ListingView');
      return new ListingView(naddr);
    },
    // The listing composer (Post button → /marketplace/post, edit from
    // the dashboard → /marketplace/edit/:naddr): a secondary detail in the
    // same column. Back returns to the feed; a successful publish hands
    // the new naddr over — the surface opens the published listing as its
    // detail.
    secondary: {
      navViewType: ['write-listing', 'edit-listing'],
      route: '/marketplace/post',
      paramRoute: naddr => `/marketplace/edit/${naddr}`,
      createDetail: async param => {
        const { ListingEditorView } = await import(
          '../addons/marketplace/ListingEditorView'
        );
        return new ListingEditorView(param, {
          onClose: naddr => {
            if (naddr) void surface.openDetail(naddr);
            else surface.back();
          },
        });
      },
    },
    // The timeline has no internal scroll — the column scrolls, so the
    // feed position survives the list ↔ detail swap.
    preserveListScroll: true,
  });
  return surface.asSurface();
};
