import { View } from '../../components/views/View';
import { HashtagSubscriptionsSettings } from './HashtagSubscriptionsSettings';

export class HashtagSubscriptionsAddonView extends View {
  private container: HTMLElement;
  private settings: HashtagSubscriptionsSettings | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-hashtag-subscriptions';
    this.container.innerHTML = `
      <h1>Hashtag Subscriptions</h1>
      <section class="section" id="hashtag-subscriptions-settings-content"></section>
      <div data-addon-content="hashtag-subscriptions"></div>
    `;
    this.settings = new HashtagSubscriptionsSettings();
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
