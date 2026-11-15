/**
 * CustomEmojisView
 *
 * Dedicated view for the Custom Emojis addon. Renders the title, the
 * settings section (toggle + management UI via CustomEmojisSettings),
 * and a content zone (queried by CustomEmojisSettings for live emoji
 * management when enabled).
 */

import { View } from '../../components/views/View';
import { CustomEmojisSettings } from './CustomEmojisSettings';
import { AddonLoader } from '../AddonLoader';
import { isFocusUiEnabled } from '../../helpers/focusUiSetting';
import { _ } from '../../i18n';

export class CustomEmojisView extends View {
  private container: HTMLElement;
  private settings: CustomEmojisSettings | null = null;
  /**
   * v2 on-demand addon lifecycle: in the Focus UI the stored preference
   * no longer gates this object — the addon loads when the object is
   * entered (constructor) and unloads when it is left (destroy), unless
   * permanently enabled via the stored preference. The enable switch is
   * hidden there (on-demand settings mode); the preference stays
   * untouched.
   */
  private readonly v2OnDemand = isFocusUiEnabled();

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-custom-emojis';
    this.container.innerHTML = `
      <div class="back-padder">
        <h1>${_('Custom Emojis')}</h1>
        ${this.v2OnDemand ? '' : '<section class="section" id="custom-emojis-settings-content"></section>'}
        <div data-addon-content="custom-emojis"></div>
      </div>
    `;
    // v2 on-demand: no toggle, management UI regardless of the preference.
    this.settings = new CustomEmojisSettings(this.v2OnDemand);
    this.settings.mount(this.container);
    if (this.v2OnDemand) {
      void AddonLoader.getInstance().ensureLoaded('custom-emojis');
    }
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.settings?.unmount();
    this.settings = null;
    this.container.innerHTML = '';
    // v2 on-demand: leaving the object ALWAYS releases the addon — even
    // with the stored preference ON (the preference only governs the
    // login-time auto-load; the next use reloads on demand).
    if (this.v2OnDemand) {
      void AddonLoader.getInstance().deactivateOnDemand('custom-emojis');
    }
  }
}
