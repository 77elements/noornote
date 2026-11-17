/**
 * Focus surface: plain addon object (v2).
 *
 * The shared shape behind the addon domains whose classic view IS the
 * object's content (calendar, badges, word filter, …): load the classic
 * addon view lazily on the first visit, cache it, attach/detach into the
 * stage's column slot. No list/detail states — the views are single
 * surfaces; deep-link params they support run through their own
 * surface file (majlis tabs, feedback-board tickets).
 *
 * Ephemeral is for the on-demand addon objects (custom-emojis,
 * scheduled-posts): the stage destroys the surface on leave and the
 * view's destroy releases the addon runtime (AddonLoader
 * deactivateOnDemand). Always-on addons keep a cached surface instead —
 * their runtime is login-managed, the view survives visits.
 */

import type { FocusDomainSurface } from './focusDomains';
import type { FocusUrlState } from './focusUrlState';
import type { SurfaceViewHandle } from './focusListDetailSurface';

export interface FocusAddonObjectSurfaceConfig {
  /** Create the classic addon view (called once, lazily). */
  load: () => Promise<SurfaceViewHandle>;
  /**
   * On-demand addon object: leaving the FV object destroys the view and
   * evicts the cached surface (the addon runtime unloads with it).
   */
  ephemeral?: boolean;
  /**
   * Deep-link restore (back/forward/reload): the surface has no list/
   * detail states of its own — a detail URL maps to a view-internal
   * state (e.g. the feedback-board ticket modal), opened here.
   */
  restore?: (handle: SurfaceViewHandle, state: FocusUrlState) => void;
}

export const focusAddonObjectSurface =
  (config: FocusAddonObjectSurfaceConfig) =>
  async (): Promise<FocusDomainSurface> => {
    const handle = await config.load();
    const el = handle.getElement();
    let current: SurfaceViewHandle | null = handle;

    return {
      attach: slot => slot.appendChild(el),
      detach: () => el.remove(),
      view: {
        restoreState(state: FocusUrlState): void {
          if (config.restore && current) config.restore(current, state);
        },
        destroy(): void {
          current?.destroy();
          current = null;
        },
      },
      ...(config.ephemeral ? { ephemeral: true } : {}),
    };
  };
