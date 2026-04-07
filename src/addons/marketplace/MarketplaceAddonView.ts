/**
 * MarketplaceAddonView
 *
 * View for the Marketplace addon page (`/addons/marketplace`):
 * shows the enable toggle + timeline-frequency settings on top, followed
 * by the live MarketplaceTimeline below.
 *
 * Distinct from `MarketplaceView` which is the standalone `/marketplace`
 * route (timeline only, no settings).
 */

import { View } from '../../components/views/View';
import { MarketplaceSettingsSection } from '../../components/settings/MarketplaceSettingsSection';
import { MarketplaceTimeline } from './MarketplaceTimeline';

export class MarketplaceAddonView extends View {
  private container: HTMLElement;
  private settings: MarketplaceSettingsSection | null = null;
  private timeline: MarketplaceTimeline | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--addon view-content--addon-marketplace';
    this.container.innerHTML = `
      <h1>Marketplace</h1>
      <section class="section" id="marketplace-settings-content"></section>
      <div data-addon-content="marketplace"></div>
    `;
    this.settings = new MarketplaceSettingsSection();
    this.settings.mount(this.container);

    const contentEl = this.container.querySelector('[data-addon-content="marketplace"]') as HTMLElement;
    if (contentEl) {
      this.timeline = new MarketplaceTimeline();
      contentEl.appendChild(this.timeline.getElement());
    }
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.settings?.unmount();
    this.settings = null;
    this.timeline?.destroy();
    this.timeline = null;
    this.container.innerHTML = '';
  }
}
