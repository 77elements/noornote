import { View } from '../../components/views/View';
import { FollowPacksSettings } from './FollowPacksSettings';
import { FollowPackManager } from './FollowPackManager';

export class FollowPacksView extends View {
  private container: HTMLElement;
  private settings: FollowPacksSettings | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addon view-content--addon-follow-packs';
    this.container.innerHTML = `
      <h1>Follow Packs</h1>
      <section class="section" id="follow-packs-settings-content"></section>
      <div data-addon-content="follow-packs"></div>
    `;
    this.settings = new FollowPacksSettings();
    this.settings.mount(this.container);

    const contentEl = this.container.querySelector('[data-addon-content="follow-packs"]') as HTMLElement;
    if (contentEl) {
      const manager = new FollowPackManager(contentEl);
      void manager.renderListTab(contentEl);
    }
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
