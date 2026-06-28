/**
 * WavlakePlayerAddonView
 *
 * View for the Wavlake Player addon page (`/addons/wavlake-player`): config only
 * (enable toggle + op3.dev play-stats toggle). The addon has no own content/board,
 * so the `data-addon-content` zone stays empty (kept for markup convention).
 */

import { View } from '../../components/views/View';
import { WavlakePlayerSettingsSection } from '../../components/settings/WavlakePlayerSettingsSection';

export class WavlakePlayerAddonView extends View {
  private container: HTMLElement;
  private settings: WavlakePlayerSettingsSection | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addon view-content--addon-wavlake-player';
    this.container.innerHTML = `
      <h1>Wavlake Player</h1>
      <section class="section" id="wavlake-player-settings-content"></section>
      <div data-addon-content="wavlake-player"></div>
    `;
    this.settings = new WavlakePlayerSettingsSection();
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
