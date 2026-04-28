import { View } from '../../components/views/View';
import { MypageSettings } from './MypageSettings';

export class MypageAddonView extends View {
  private container: HTMLElement;
  private settings: MypageSettings | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addon view-content--addon-mypage';
    this.container.innerHTML = `
      <h1>My Page</h1>
      <section class="section" id="mypage-settings-content"></section>
      <div data-addon-content="mypage"></div>
    `;
    this.settings = new MypageSettings();
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
