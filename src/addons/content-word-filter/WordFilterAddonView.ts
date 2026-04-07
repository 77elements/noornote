import { View } from '../../components/views/View';
import { ContentWordFilterSettings, mountWordFilterContent } from './ContentWordFilterSettings';

export class WordFilterAddonView extends View {
  private container: HTMLElement;
  private settings: ContentWordFilterSettings | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addon view-content--addon-wordfilter';
    this.container.innerHTML = `
      <h1>Word Filter</h1>
      <section class="section" id="content-word-filter-settings-content"></section>
      <div data-addon-content="wordfilter"></div>
    `;
    this.settings = new ContentWordFilterSettings();
    this.settings.mount(this.container);

    const contentEl = this.container.querySelector('[data-addon-content="wordfilter"]') as HTMLElement;
    if (contentEl) {
      mountWordFilterContent(contentEl);
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
