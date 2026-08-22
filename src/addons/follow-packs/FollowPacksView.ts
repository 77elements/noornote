import { View } from '../../components/views/View';
import { FollowPacksSettings } from './FollowPacksSettings';
import { FollowPackManager } from './FollowPackManager';
import { TypedEventBus } from '../../core/TypedEventBus';
import { isFollowPacksEnabled } from './index';

export class FollowPacksView extends View {
  private container: HTMLElement;
  private contentEl: HTMLElement | null = null;
  private settings: FollowPacksSettings | null = null;
  private toggleSubId: string | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-follow-packs';
    this.container.innerHTML = `
      <h1>Follow Packs</h1>
      <section class="section" id="follow-packs-settings-content"></section>
      <div data-addon-content="follow-packs"></div>
    `;
    this.settings = new FollowPacksSettings();
    this.settings.mount(this.container);

    this.contentEl = this.container.querySelector(
      '[data-addon-content="follow-packs"]'
    ) as HTMLElement;

    if (isFollowPacksEnabled()) {
      this.mountContent();
    }

    this.toggleSubId = TypedEventBus.getInstance().on(
      'follow-packs:toggle',
      (payload: { enabled: boolean }) => {
        if (payload.enabled) this.mountContent();
        else this.unmountContent();
      }
    );
  }

  private mountContent(): void {
    if (!this.contentEl || this.contentEl.childElementCount > 0) return;
    const manager = new FollowPackManager(this.contentEl);
    void manager.renderListTab(this.contentEl);
  }

  private unmountContent(): void {
    if (this.contentEl) this.contentEl.innerHTML = '';
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.toggleSubId) {
      TypedEventBus.getInstance().off(this.toggleSubId);
      this.toggleSubId = null;
    }
    this.settings?.unmount();
    this.settings = null;
    this.container.innerHTML = '';
    this.contentEl = null;
  }
}
