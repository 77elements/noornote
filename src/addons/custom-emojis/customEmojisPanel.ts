/**
 * Custom Emojis ED-b panel (v2 composer settings).
 *
 * Mounted by the composer's ED-b settings composition ABOVE the
 * scheduled posts list (more frequently used). Reuses the addon's
 * management UI (CustomEmojisSettings in on-demand mode: no enable
 * toggle — the stored preference is meaningless in v2, the runtime is
 * owned by the composer session and released when the composer closes,
 * NOT when this panel is torn down).
 */

import { AddonLoader } from '../AddonLoader';
import { CustomEmojisSettings } from './CustomEmojisSettings';

/** Structural FocusSettingsView — avoids importing the v2 shell layer. */
interface SettingsPanel {
  mount(el: HTMLElement): void;
  destroy(): void;
}

export const createCustomEmojisSettings = (): SettingsPanel => {
  let host: HTMLElement | null = null;
  let settings: CustomEmojisSettings | null = null;

  return {
    mount(el: HTMLElement): void {
      host = el;
      // No settings section in on-demand mode (no toggle) — an empty
      // .section would render as a dark pill above the management UI.
      el.innerHTML = `<div data-addon-content="custom-emojis"></div>`;
      settings = new CustomEmojisSettings(true);
      settings.mount(el);
      // On-demand: the runtime is loaded with the composer session —
      // this is idempotent (no-op when already loaded).
      void AddonLoader.getInstance().ensureLoaded('custom-emojis');
    },
    destroy(): void {
      settings?.unmount();
      settings = null;
      if (host) host.innerHTML = '';
      host = null;
      // NO deactivate here: the composer session still needs the runtime
      // (autocomplete, publish tagging) — releaseOnDemandAddons in the
      // composer owns the release.
    },
  };
};
