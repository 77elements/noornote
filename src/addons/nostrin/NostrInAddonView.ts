import { View } from '../../components/views/View';
import { NostrInSettings } from './NostrInSettings';

export class NostrInAddonView extends View {
  private container: HTMLElement;
  private settings: NostrInSettings | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addon view-content--addon-nostrin';
    this.container.innerHTML = `
      <h1>NostrIn</h1>
      <section class="section" id="nostrin-settings-content"></section>
      <div data-addon-content="nostrin"></div>
    `;
    this.settings = new NostrInSettings();
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
