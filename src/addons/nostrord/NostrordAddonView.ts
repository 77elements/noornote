import { View } from '../../components/views/View';
import { NostrordSettings } from './NostrordSettings';

export class NostrordAddonView extends View {
  private container: HTMLElement;
  private settings: NostrordSettings | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addon view-content--addon-nostrord';
    this.container.innerHTML = `
      <h1>Nostrord</h1>
      <section class="section" id="nostrord-settings-content"></section>
      <div data-addon-content="nostrord"></div>
    `;
    this.settings = new NostrordSettings();
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
