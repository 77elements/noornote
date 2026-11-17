/**
 * Focus surface: tabbed addon object (v2).
 *
 * The shared shape behind addon domains whose classic view IS the object's
 * content and carries tabs (Nostr Majlis, Calendar): a tab is a real URL
 * state — deep links (dhikr notification, "Show tafsir", booking links)
 * land on the tab, user tab switches sync the URL, back/forward restores
 * the tab.
 *
 * Restoring RECREATES the view with the requested initial tab: the classic
 * views render one active tab at construction, so a fresh view per tab is
 * exactly what the classic routes do. The swap replaces elements in place —
 * views' destroy() do not detach their elements, so the surface removes the
 * old element itself and mounts the new one into the slot it is attached to
 * (exactly one content element in the stage's column slot).
 */

import type {
  FocusDomainSurface,
  FocusDomainSurfaceView,
} from './focusDomains';
import type { FocusUrlState } from './focusUrlState';
import type { SurfaceViewHandle } from './focusListDetailSurface';
import { pushFocusUrl } from './focusHistorySync';

export interface FocusTabbedObjectSurfaceConfig {
  /** Create the view; the argument is the initial tab (null = default tab). */
  create: (initialTab: string | null) => Promise<SurfaceViewHandle>;
  /** The tab a parsed URL state requests (null = the default tab). */
  tabFromState: (state: FocusUrlState) => string | null;
  /**
   * The DOM tab id that counts as the object's default (bare route):
   * switching to it in the view normalizes the URL state back to null.
   */
  defaultTab: string;
  /** The canonical URL for a tab state (null = the default tab's route). */
  tabUrl: (tab: string | null) => string;
  /** On-demand addon object: the stage destroys the surface on leave. */
  ephemeral?: boolean;
}

export const focusTabbedObjectSurface =
  (config: FocusTabbedObjectSurfaceConfig) =>
  async (): Promise<FocusDomainSurface> => {
    let tab: string | null = null;
    let handle = await config.create(null);
    let slot: HTMLElement | null = null;
    // Invalidation token: a recreate/destroy racing an in-flight create
    // must never mount a stale view.
    let mountToken = 0;

    const wire = (next: SurfaceViewHandle): void => {
      // User tab switch inside the view → sync the URL (pushes history).
      // The default tab normalizes back to the null state (bare route).
      next.onTabChange = tabId => {
        tab = tabId === config.defaultTab ? null : tabId;
        pushFocusUrl(config.tabUrl(tab));
      };
    };
    wire(handle);

    /** Fresh view per tab: destroy the old one, mount the new in its place. */
    const recreate = (nextTab: string | null): Promise<void> => {
      const token = ++mountToken;
      tab = nextTab;
      handle.getElement().remove();
      handle.destroy();
      return config.create(nextTab).then(next => {
        if (token !== mountToken) {
          next.destroy();
          return;
        }
        handle = next;
        wire(handle);
        if (slot) slot.appendChild(handle.getElement());
      });
    };

    const viewHandle: FocusDomainSurfaceView = {
      /** Sync the URL with the current tab (re-mounts keep their route). */
      syncUrl(): void {
        pushFocusUrl(config.tabUrl(tab));
      },
      /** Back/forward/deep-link: restore the tab the URL describes. */
      restoreState(state: FocusUrlState): Promise<void> | void {
        const next = config.tabFromState(state);
        if (next === tab) return;
        return recreate(next);
      },
      destroy(): void {
        mountToken++;
        slot = null;
        handle.destroy();
      },
    };

    return {
      attach: theSlot => {
        slot = theSlot;
        slot.appendChild(handle.getElement());
      },
      detach: () => {
        handle.getElement().remove();
        slot = null;
      },
      view: viewHandle,
      ...(config.ephemeral ? { ephemeral: true } : {}),
    };
  };
