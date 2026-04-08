import { View } from '../../components/views/View';
import { ContentWordFilterSettings, mountWordFilterContent } from './ContentWordFilterSettings';
import { EventBus } from '../../services/EventBus';
import { isContentWordFilterEnabled } from './index';

export class WordFilterAddonView extends View {
  private container: HTMLElement;
  private contentEl: HTMLElement | null = null;
  private settings: ContentWordFilterSettings | null = null;
  private toggleSubId: string | null = null;

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

    this.contentEl = this.container.querySelector('[data-addon-content="wordfilter"]') as HTMLElement;

    if (isContentWordFilterEnabled()) {
      this.mountContent();
    }

    this.toggleSubId = EventBus.getInstance().on('content-word-filter:toggle', (payload: { enabled: boolean }) => {
      if (payload.enabled) this.mountContent();
      else this.unmountContent();
    });
  }

  private mountContent(): void {
    if (!this.contentEl || this.contentEl.childElementCount > 0) return;
    mountWordFilterContent(this.contentEl);
  }

  private unmountContent(): void {
    if (this.contentEl) this.contentEl.innerHTML = '';
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.toggleSubId) {
      EventBus.getInstance().off(this.toggleSubId);
      this.toggleSubId = null;
    }
    this.settings?.unmount();
    this.settings = null;
    this.container.innerHTML = '';
    this.contentEl = null;
  }
}
