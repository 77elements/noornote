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

export class CustomEmojisView extends View {
  private container: HTMLElement;
  private settings: CustomEmojisSettings | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-custom-emojis';
    this.container.innerHTML = `
      <h1>Custom Emojis</h1>
      <section class="section" id="custom-emojis-settings-content"></section>
      <div data-addon-content="custom-emojis"></div>
    `;
    this.settings = new CustomEmojisSettings();
    this.settings.mount(this.container);
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.settings?.unmount();
    this.settings = null;
    this.container.innerHTML = '';
  }
}
