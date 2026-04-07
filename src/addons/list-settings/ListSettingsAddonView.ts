import { View } from '../../components/views/View';
import { ListSettingsSection } from '../../components/settings/ListSettingsSection';

export class ListSettingsAddonView extends View {
  private container: HTMLElement;
  private settings: ListSettingsSection | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addon view-content--addon-list-settings';
    this.container.innerHTML = `
      <h1>List Sync Mode</h1>
      <section class="section" id="list-settings-content"></section>
      <div data-addon-content="list-settings"></div>
    `;
    this.settings = new ListSettingsSection();
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
