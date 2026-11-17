/**
 * The Nostr Majlis FV object surface (v2): ephemeral, plain attach/detach
 * like custom-emojis (the view brings its own h1). On-demand addon object:
 * entering the object loads the addon (NostrMajlisAddonView constructor),
 * leaving it releases it again — unless one of the two majlis widgets is
 * active (always-on reasons, see nostr-majlis/index.ts
 * isNostrMajlisAutoLoaded).
 *
 * Tab deep links (dhikr notification, the quran widget's "Show tafsir"):
 * `/addons/nostr-majlis/:tab` maps to a detail state — the surface
 * recreates its view with the initial tab when the requested tab differs
 * (a fresh view per tab, exactly like the classic routes mount one).
 */

import type {
  FocusDomainSurface,
  FocusDomainSurfaceView,
} from './focusDomains';
import type { FocusUrlState } from './focusUrlState';
import { pushFocusUrl } from './focusHistorySync';

export const focusMajlisSurface = async (): Promise<FocusDomainSurface> => {
  const { NostrMajlisAddonView } = await import(
    '../addons/nostr-majlis/NostrMajlisAddonView'
  );

  /** The tab the current view was created with (null = default salah). */
  let tab: string | null = null;
  let view = new NostrMajlisAddonView();

  const recreate = (nextTab: string | null): void => {
    tab = nextTab;
    view.destroy();
    view = new NostrMajlisAddonView(nextTab ?? undefined);
  };

  const viewHandle: FocusDomainSurfaceView = {
    restoreState(state: FocusUrlState): void {
      const next = state.kind === 'detail' ? (state.param ?? null) : null;
      if (next !== tab) recreate(next);
    },
    /** Sync the URL with the current tab (circle click pushes the route). */
    syncUrl(): void {
      pushFocusUrl(
        tab ? `/addons/nostr-majlis/${tab}` : '/addons/nostr-majlis'
      );
    },
    destroy(): void {
      view.destroy();
    },
  };

  return {
    attach: slot => slot.appendChild(view.getElement()),
    detach: () => view.getElement().remove(),
    view: viewHandle,
    ephemeral: true,
  };
};
