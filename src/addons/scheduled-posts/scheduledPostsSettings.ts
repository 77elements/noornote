/**
 * Scheduled Posts ED-b object settings (v2).
 *
 * While the flat composer (/timeline/new-note) is open, the social
 * object's gear opens the ED-b with THIS panel instead of the timeline
 * settings: the list of pending scheduled posts. Part of the on-demand
 * addon lifecycle — the addon code loads when the panel mounts and
 * unloads again when it is torn down (drawer close, object switch,
 * composer close), unless the user permanently enabled the addon.
 */

import { AddonLoader } from '../AddonLoader';
import { isScheduledPostsEnabled } from './index';
import { ScheduledPostsList } from './ScheduledPostsList';
import { _ } from '../../i18n';

/** Structural FocusSettingsView — avoids importing the v2 shell layer. */
interface SettingsPanel {
  mount(el: HTMLElement): void;
  destroy(): void;
}

export const createScheduledPostsSettings = (): SettingsPanel => {
  let host: HTMLElement | null = null;
  let list: ScheduledPostsList | null = null;

  return {
    mount(el: HTMLElement): void {
      host = el;
      el.innerHTML = `<h2>${_('Your scheduled posts')}</h2>`;
      const listEl = document.createElement('div');
      listEl.className = 'ui-list focus-scheduled-posts';
      el.appendChild(listEl);
      list = new ScheduledPostsList();
      list.mount(listEl);
      // On-demand: load the addon code while its functionality is shown.
      void AddonLoader.getInstance().ensureLoaded('scheduled-posts');
    },
    destroy(): void {
      list?.destroy();
      list = null;
      if (host) host.innerHTML = '';
      host = null;
      // Work done / panel gone → release (unless permanently enabled).
      if (!isScheduledPostsEnabled()) {
        void AddonLoader.getInstance().deactivateOnDemand('scheduled-posts');
      }
    },
  };
};
