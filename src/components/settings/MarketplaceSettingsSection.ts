/**
 * MarketplaceSettingsSection
 * Toggle the Marketplace Add-On on/off.
 * Toggle profile-page Products carousel (viewer-side preference — shows
 * NIP-99 listings on every visited profile that has any, NoorNote user
 * or not).
 * Toggle timeline listing injection with frequency selector.
 * Emits 'marketplace:toggle' so sidebar updates instantly (no reload needed).
 */

import { SettingsSection } from './SettingsSection';
import { Switch } from '../ui/Switch';
import {
  isMarketplaceEnabled, setMarketplaceEnabled,
  isTimelineListingsEnabled, setTimelineListingsEnabled,
  getTimelineListingFrequency, setTimelineListingFrequency,
  isProfileListingsEnabled, setProfileListingsEnabled,
  type ListingFrequency
} from '../../addons/marketplace/index';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';

export class MarketplaceSettingsSection extends SettingsSection {
  private marketplaceSwitch: Switch | null = null;
  private timelineSwitch: Switch | null = null;
  private profileListingsSwitch: Switch | null = null;

  constructor() {
    super('marketplace-settings');
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    const marketplaceEnabled = isMarketplaceEnabled();

    this.marketplaceSwitch = new Switch({
      label: '',
      checked: marketplaceEnabled,
      onChange: (checked) => {
        setMarketplaceEnabled(checked);
        // Emit the uniform AddonLoader event + the legacy event so existing
        // listeners (Timeline, MainLayout sidebar, MarketplaceAddonView) keep
        // working unchanged.
        const bus = TypedEventBus.getInstance();
        bus.emit('marketplace:addon-toggle', { enabled: checked });
        bus.emit('marketplace:toggle', { enabled: checked });
        this.updateTimelineVisibility(contentContainer);
        ToastService.show(checked ? 'Marketplace enabled' : 'Marketplace disabled', 'success');
      }
    });

    this.profileListingsSwitch = new Switch({
      label: '',
      checked: isProfileListingsEnabled(),
      onChange: (checked) => {
        setProfileListingsEnabled(checked);
        TypedEventBus.getInstance().emit('marketplace:profile-listings-toggle', { enabled: checked });
        ToastService.show(
          checked ? 'Products carousel enabled on profiles' : 'Products carousel hidden on profiles',
          'success'
        );
      }
    });

    this.timelineSwitch = new Switch({
      label: '',
      checked: isTimelineListingsEnabled(),
      onChange: (checked) => {
        setTimelineListingsEnabled(checked);
        TypedEventBus.getInstance().emit('marketplace:timeline-toggle', { enabled: checked });
        this.updateFrequencyVisibility(contentContainer);
        ToastService.show(checked ? 'Timeline listings enabled' : 'Timeline listings disabled', 'success');
      }
    });

    const currentFreq = getTimelineListingFrequency();
    const freqOptions: Array<[ListingFrequency, string]> = [
      ['rare', 'Rare (every 60 min)'],
      ['moderate', 'Moderate (every 30 min)'],
      ['frequent', 'Frequent (every 15 min)'],
      ['more-frequent', 'More Frequent (every 5 min)'],
      ['realtime', 'Every 60 seconds'],
    ];

    contentContainer.innerHTML = `
      <div class="setting">
        <span class="setting__label">Enable Marketplace</span>
        <div class="setting__control">${this.marketplaceSwitch.render()}</div>
      </div>

      <div class="marketplace-timeline-settings${marketplaceEnabled ? '' : ' is-hidden'}">
        <div class="setting">
          <span class="setting__label">Show user's products on the profile page</span>
          <div class="setting__control">${this.profileListingsSwitch.render()}</div>
        </div>

        <div class="setting">
          <span class="setting__label">Show listings from people I follow in my timeline</span>
          <div class="setting__control">${this.timelineSwitch.render()}</div>
        </div>

        <div class="frequency-selector${isTimelineListingsEnabled() ? '' : ' is-hidden'}">
          ${freqOptions.map(([value, label]) => `
            <label class="nn-checkbox nn-checkbox--label-left">
              <span class="setting__label">${label}</span>
              <input type="radio" name="listing-freq" value="${value}" ${currentFreq === value ? 'checked' : ''} />
            </label>
          `).join('')}
        </div>
      </div>
    `;

    this.marketplaceSwitch.setupEventListeners(contentContainer);
    this.profileListingsSwitch.setupEventListeners(contentContainer);
    this.timelineSwitch.setupEventListeners(contentContainer);

    // Frequency radio buttons
    contentContainer.querySelectorAll('input[name="listing-freq"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const value = (e.target as HTMLInputElement).value as ListingFrequency;
        setTimelineListingFrequency(value);
        TypedEventBus.getInstance().emit('marketplace:timeline-frequency-change', { frequency: value });
        const labels: Record<ListingFrequency, string> = {
          rare: 'Rare (60 min)',
          moderate: 'Moderate (30 min)',
          frequent: 'Frequent (15 min)',
          'more-frequent': 'More Frequent (5 min)',
          realtime: 'Every 60 seconds'
        };
        ToastService.show(`Listing frequency: ${labels[value] || value}`, 'success');
      });
    });
  }

  private updateTimelineVisibility(container: HTMLElement): void {
    const timelineSettings = container.querySelector('.marketplace-timeline-settings');
    if (timelineSettings) {
      timelineSettings.classList.toggle('is-hidden', !isMarketplaceEnabled());
    }
  }

  private updateFrequencyVisibility(container: HTMLElement): void {
    const selector = container.querySelector('.frequency-selector');
    if (selector) {
      selector.classList.toggle('is-hidden', !isTimelineListingsEnabled());
    }
  }

  public unmount(): void {
    if (this.marketplaceSwitch) {
      this.marketplaceSwitch.destroy();
      this.marketplaceSwitch = null;
    }
    if (this.profileListingsSwitch) {
      this.profileListingsSwitch.destroy();
      this.profileListingsSwitch = null;
    }
    if (this.timelineSwitch) {
      this.timelineSwitch.destroy();
      this.timelineSwitch = null;
    }
  }
}
