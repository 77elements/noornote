/**
 * WebCommentsAddonView — toggle-only settings page for the Web Comments addon
 * (`/addons/web-comments`). Phase 1 is render-only, so no rich settings UI.
 */

import { AddonToggleView } from '../AddonToggleView';
import { isWebCommentsEnabled, setWebCommentsEnabled } from './index';

export class WebCommentsAddonView extends AddonToggleView {
  constructor() {
    super({
      id: 'web-comments',
      name: 'Web Comments',
      description: 'Show comments posted on external web pages (NIP-22 / NIP-73) right inside the note, with a link to the page.',
      toggleEvent: 'web-comments:addon-toggle',
      isEnabled: () => isWebCommentsEnabled(),
      setEnabled: (v) => setWebCommentsEnabled(v),
    });
  }
}
