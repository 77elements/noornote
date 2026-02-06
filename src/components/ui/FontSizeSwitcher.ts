/**
 * FontSizeSwitcher
 * Inline − / + controls for font-size scaling.
 * Mounted in .user-login-bar before AccountSwitcher.
 */

import { FontSizeService } from '../../services/FontSizeService';
import { EventBus } from '../../services/EventBus';

export class FontSizeSwitcher {
  private element: HTMLElement;
  private fontSizeService: FontSizeService;
  private subscription: string;

  constructor() {
    this.fontSizeService = FontSizeService.getInstance();
    this.element = this.createElement();
    this.updateButtonStates();

    this.subscription = EventBus.getInstance().on('font-size:changed', () => {
      this.updateButtonStates();
    });
  }

  private createElement(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'font-size-switcher';
    container.innerHTML = `
      <span class="font-size-switcher__label">Font Size</span>
      <button class="btn btn--secondary btn--fontsizeswitcher font-size-switcher__btn--decrease" type="button" title="Decrease font size">&minus;</button>
      <button class="btn btn--secondary btn--fontsizeswitcher font-size-switcher__btn--increase" type="button" title="Increase font size">+</button>
    `;

    container.querySelector('.font-size-switcher__btn--decrease')!
      .addEventListener('click', () => this.fontSizeService.cycleDown());

    container.querySelector('.font-size-switcher__btn--increase')!
      .addEventListener('click', () => this.fontSizeService.cycleUp());

    return container;
  }

  private updateButtonStates(): void {
    const scale = this.fontSizeService.getScale();
    const dec = this.element.querySelector('.font-size-switcher__btn--decrease') as HTMLButtonElement;
    const inc = this.element.querySelector('.font-size-switcher__btn--increase') as HTMLButtonElement;
    if (dec) dec.disabled = scale === 'small';
    if (inc) inc.disabled = scale === 'x-large';
  }

  public getElement(): HTMLElement {
    return this.element;
  }

  public destroy(): void {
    EventBus.getInstance().off(this.subscription);
    this.element.remove();
  }
}
