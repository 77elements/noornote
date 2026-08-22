import { View } from '../../components/views/View';
import { ProfileRecognitionSettings } from './ProfileRecognitionSettings';

export class ProfileRecognitionView extends View {
  private container: HTMLElement;
  private settings: ProfileRecognitionSettings | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-profile-recognition';
    this.container.innerHTML = `
      <h1>Profile Recognition</h1>
      <section class="section" id="profile-recognition-settings-content"></section>
      <div data-addon-content="profile-recognition"></div>
    `;
    this.settings = new ProfileRecognitionSettings();
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
