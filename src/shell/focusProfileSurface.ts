/**
 * Focus surface: Profile (v2).
 *
 * A FocusListDetailSurface wired to the profile domain: the cached list
 * is the user's OWN ProfileView (the circle click entry — same as v1's
 * sidebar Profile button), clicking a `.user-identity` on any note
 * opens that user's ProfileView as the detail (focus navigation seam,
 * view type 'profile'). The URL follows along (/profile ↔
 * /profile/:npub) as real history steps.
 *
 * The secondary detail is the flat profile editor at /profile/edit —
 * the v2 replacement for the classic ProfileEditModal (same elements,
 * one shared form component; the modal stays for the classic UI).
 */

import type { FocusDomainSurface } from './focusDomains';
import { FocusListDetailSurface } from './focusListDetailSurface';
import { AuthService } from '../services/AuthService';

export const profileSurface = async (): Promise<FocusDomainSurface> => {
  // Own profile = the list state. The npub comes from the session — the
  // surface is created on demand (circle click / seam), always logged in.
  const currentUser = AuthService.getInstance().getCurrentUser();
  const ownNpub = currentUser?.npub ?? '';

  const surface = new FocusListDetailSurface({
    navViewType: 'profile',
    listRoute: '/profile',
    detailRoute: npub => `/profile/${npub}`,
    createList: async () => {
      const { ProfileView } = await import('../components/views/ProfileView');
      return new ProfileView(ownNpub);
    },
    createDetail: async npub => {
      const { ProfileView } = await import('../components/views/ProfileView');
      return new ProfileView(npub);
    },
    // The flat profile editor (/profile/edit) — post/cancel return to
    // the profile via the surface's back action.
    secondary: {
      navViewType: 'profile-edit',
      route: '/profile/edit',
      createDetail: async () => {
        const { ProfileEditView } = await import(
          '../components/views/ProfileEditView'
        );
        return new ProfileEditView({ onClose: () => surface.back() });
      },
    },
  });
  return surface.asSurface();
};
