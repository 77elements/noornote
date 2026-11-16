/**
 * The Nostr Majlis FV object surface (v2): ephemeral, plain attach/detach
 * like custom-emojis (the view brings its own h1). On-demand addon object:
 * entering the object loads the addon (NostrMajlisAddonView constructor),
 * leaving it releases it again — unless one of the two majlis widgets is
 * active (always-on reasons, see nostr-majlis/index.ts
 * isNostrMajlisAutoLoaded).
 */

import type { FocusDomainSurface } from './focusDomains';

export const focusMajlisSurface = async (): Promise<FocusDomainSurface> => {
  const { NostrMajlisAddonView } = await import(
    '../addons/nostr-majlis/NostrMajlisAddonView'
  );
  const view = new NostrMajlisAddonView();
  const el = view.getElement();
  return {
    attach: slot => slot.appendChild(el),
    detach: () => el.remove(),
    view,
    ephemeral: true,
  };
};
