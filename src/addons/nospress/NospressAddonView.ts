import { View } from '../../components/views/View';
import { NospressSettings } from './NospressSettings';
import { isNospressEnabled } from './index';
import { AuthService } from '../../services/AuthService';
import { Router } from '../../services/Router';
import { EventBus } from '../../services/EventBus';

export class NospressAddonView extends View {
  private container: HTMLElement;
  private settings: NospressSettings | null = null;
  private toggleSubId: string | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addon view-content--addon-nospress';
    this.container.innerHTML = `
      <h1>NosPress</h1>
      <section class="section" id="nospress-settings-content"></section>
      <div data-addon-content="nospress"></div>
    `;
    this.settings = new NospressSettings();
    this.settings.mount(this.container);

    this.renderSetupButton();
    this.toggleSubId = EventBus.getInstance().on('nospress:toggle', () => this.renderSetupButton());
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
  }

  private renderSetupButton(): void {
    const slot = this.container.querySelector('[data-addon-content="nospress"]') as HTMLElement | null;
    if (!slot) return;

    if (!isNospressEnabled()) {
      slot.innerHTML = '';
      return;
    }

    const npub = AuthService.getInstance().getCurrentUser()?.npub;
    if (!npub) {
      slot.innerHTML = '';
      return;
    }

    const href = `/profile/${npub}/nospress`;
    const hasRoom = window.innerWidth >= NospressAddonView.MIN_WIDTH_PX;

    if (hasRoom) {
      slot.innerHTML = `
        <div class="nospress-addon__open">
          <a class="btn" href="${href}" data-action="open-nospress">Open NosPress</a>
        </div>
      `;
      const btn = slot.querySelector('[data-action="open-nospress"]') as HTMLAnchorElement | null;
      btn?.addEventListener('click', (e) => {
        e.preventDefault();
        Router.getInstance().navigate(href);
      });
    } else {
      slot.innerHTML = `
        <div class="nospress-addon__open">
          <button class="btn" disabled data-action="open-nospress-disabled">Open NosPress</button>
          <p class="nospress-addon__hint">
            NosPress requires a screen at least ${NospressAddonView.MIN_WIDTH_PX}px wide and is best used on the desktop app (Linux / macOS) or the web app on a desktop browser.
          </p>
        </div>
      `;
    }
  }

  /** Minimum viewport width for the NosPress editor. Below this we hard-gate. */
  private static readonly MIN_WIDTH_PX = 1024;
}
