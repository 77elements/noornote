/**
 * MarketplaceAddonView
 *
 * View for the Marketplace addon page (`/addons/marketplace`):
 * shows the enable toggle + timeline-frequency settings on top, followed
 * by the live MarketplaceTimeline below — but only while the addon is
 * enabled. Reacts live to toggles via the `marketplace:toggle` event.
 *
 * Distinct from `MarketplaceView` which is the standalone `/marketplace`
 * route (timeline only, no settings).
 */

import { View } from '../../components/views/View';
import { MarketplaceSettingsSection } from '../../components/settings/MarketplaceSettingsSection';
import { MarketplaceTimeline } from './MarketplaceTimeline';
import { TypedEventBus } from '../../core/TypedEventBus';
import { isMarketplaceEnabled } from './index';

export class MarketplaceAddonView extends View {
  private container: HTMLElement;
  private contentEl: HTMLElement | null = null;
  private settings: MarketplaceSettingsSection | null = null;
  private timeline: MarketplaceTimeline | null = null;
  private toggleSubId: string | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-marketplace';
    this.container.innerHTML = `
      <h1>Marketplace</h1>
      <section class="section" id="marketplace-settings-content"></section>
      <div data-addon-content="marketplace"></div>
    `;
    this.settings = new MarketplaceSettingsSection();
    this.settings.mount(this.container);

    this.contentEl = this.container.querySelector(
      '[data-addon-content="marketplace"]'
    ) as HTMLElement;

    if (isMarketplaceEnabled()) {
      this.mountTimeline();
    }

    this.toggleSubId = TypedEventBus.getInstance().on(
      'marketplace:toggle',
      (payload: { enabled: boolean }) => {
        if (payload.enabled) this.mountTimeline();
        else this.unmountTimeline();
      }
    );
  }

  private mountTimeline(): void {
    if (!this.contentEl || this.timeline) return;
    this.timeline = new MarketplaceTimeline();
    this.contentEl.appendChild(this.timeline.getElement());
  }

  private unmountTimeline(): void {
    this.timeline?.destroy();
    this.timeline = null;
    if (this.contentEl) this.contentEl.innerHTML = '';
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    if (this.toggleSubId) {
      TypedEventBus.getInstance().off(this.toggleSubId);
      this.toggleSubId = null;
    }
    this.settings?.unmount();
    this.settings = null;
    this.unmountTimeline();
    this.contentEl = null;
    this.container.innerHTML = '';
  }
}
