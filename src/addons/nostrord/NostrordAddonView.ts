import { View } from '../../components/views/View';
import { NostrordSettings } from './NostrordSettings';

export class NostrordAddonView extends View {
  private container: HTMLElement;
  private settings: NostrordSettings | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    // CSS class retains the legacy `--addon-nostrord` slug — the addon id and
    // route stay `nostrord` for backward compat (existing bookmarks, saved
    // flags), only the user-facing label changed to "Group Chats" when Armada
    // support was added alongside NIP-29 in v1.3.4.
    this.container.className = 'view-content view-content--addon view-content--addon-nostrord';
    this.container.innerHTML = `
      <h1>Group Chats</h1>
      <p class="form__note">
        Heads-up notifications when your group chat communities come alive.
        Currently supports Nostrord (NIP-29) and Armada (Concord).
      </p>
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
