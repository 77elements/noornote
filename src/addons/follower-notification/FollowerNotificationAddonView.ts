import { View } from '../../components/views/View';
import { FollowerNotificationSettings } from './FollowerNotificationSettings';

export class FollowerNotificationAddonView extends View {
  private container: HTMLElement;
  private settings: FollowerNotificationSettings | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addon view-content--addon-follower-notification';
    this.container.innerHTML = `
      <h1>Follower Notification</h1>
      <section class="section" id="follower-notification-settings-content"></section>
      <div data-addon-content="follower-notification"></div>
    `;
    this.settings = new FollowerNotificationSettings();
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
