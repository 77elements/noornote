/**
 * RelayBrowserView
 * View wrapper for RelayBrowser component.
 * Receives decoded relay URL from router paramHandler.
 */

import { View } from './View';
import { RelayBrowser } from '../relay-browser/RelayBrowser';

export class RelayBrowserView extends View {
  private container: HTMLElement;
  private browser: RelayBrowser | null = null;

  constructor(relayUrl: string) {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--relay-browser';

    this.browser = new RelayBrowser(relayUrl);
    this.container.appendChild(this.browser.getElement());
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.browser) {
      this.browser.destroy();
      this.browser = null;
    }
    this.container.innerHTML = '';
  }
}
