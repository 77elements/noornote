/**
 * MarketplaceView
 * View wrapper for MarketplaceTimeline component.
 *
 * Part of the Marketplace Add-On — only loaded when feature is enabled.
 */

import { View } from '../../components/views/View';
import { MarketplaceTimeline } from './MarketplaceTimeline';

export class MarketplaceView extends View {
  private container: HTMLElement;
  private timeline: MarketplaceTimeline | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--marketplace';
    this.render();
  }

  private render(): void {
    this.container.innerHTML = `<div class="marketplace-view__content"></div>`;

    this.timeline = new MarketplaceTimeline();
    const contentArea = this.container.querySelector('.marketplace-view__content');
    contentArea?.appendChild(this.timeline.getElement());
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.timeline) {
      this.timeline.destroy();
      this.timeline = null;
    }
    this.container.innerHTML = '';
  }
}
