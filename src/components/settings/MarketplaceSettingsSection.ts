/**
 * MarketplaceSettingsSection
 * Toggle the Marketplace Add-On on/off.
 * Toggle timeline listing injection with frequency selector.
 * Emits 'marketplace:toggle' so sidebar updates instantly (no reload needed).
 */

import { SettingsSection } from './SettingsSection';
import { Switch } from '../ui/Switch';
import {
  isMarketplaceEnabled, setMarketplaceEnabled,
  isTimelineListingsEnabled, setTimelineListingsEnabled,
  setTimelineListingFrequency
} from '../../addons/marketplace/index';
import { EventBus } from '../../services/EventBus';
import { ToastService } from '../../services/ToastService';

export class MarketplaceSettingsSection extends SettingsSection {
  private marketplaceSwitch: Switch | null = null;
  private timelineSwitch: Switch | null = null;

  constructor() {
    super('marketplace-settings');
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    const marketplaceEnabled = isMarketplaceEnabled();

    this.marketplaceSwitch = new Switch({
      label: 'Enable Marketplace',
      checked: marketplaceEnabled,
      onChange: (checked) => {
        setMarketplaceEnabled(checked);
        EventBus.getInstance().emit('marketplace:toggle', { enabled: checked });
        this.updateTimelineVisibility(contentContainer);
        ToastService.show(checked ? 'Marketplace enabled' : 'Marketplace disabled', 'success');
      }
    });

    this.timelineSwitch = new Switch({
      label: 'Show listings from people I follow in my timeline',
      checked: isTimelineListingsEnabled(),
      onChange: (checked) => {
        setTimelineListingsEnabled(checked);
        EventBus.getInstance().emit('marketplace:timeline-toggle', { enabled: checked });
        this.updateFrequencyVisibility(contentContainer);
        ToastService.show(checked ? 'Timeline listings enabled' : 'Timeline listings disabled', 'success');
      }
    });

    const rawFreq = localStorage.getItem('noornote_marketplace_timeline_frequency') || 'rare';
    const currentFreq = rawFreq;
    const devOption = import.meta.env.DEV
      ? `<label class="frequency-option">
           <input type="radio" name="listing-freq" value="dev" ${currentFreq === ('dev' as string) ? 'checked' : ''} />
           <span>Every 60s (Dev)</span>
         </label>`
      : '';

    contentContainer.innerHTML = `
      <p class="addon-section__beta">Beta — This feature is still in development. Expect rough edges.</p>
      ${this.marketplaceSwitch.render()}
      <div class="marketplace-timeline-settings${marketplaceEnabled ? '' : ' is-hidden'}">
        ${this.timelineSwitch.render()}
        <div class="frequency-selector${isTimelineListingsEnabled() ? '' : ' is-hidden'}">
          <label class="frequency-option">
            <input type="radio" name="listing-freq" value="rare" ${currentFreq === 'rare' ? 'checked' : ''} />
            <span>Rare (every 60 min)</span>
          </label>
          <label class="frequency-option">
            <input type="radio" name="listing-freq" value="moderate" ${currentFreq === 'moderate' ? 'checked' : ''} />
            <span>Moderate (every 30 min)</span>
          </label>
          <label class="frequency-option">
            <input type="radio" name="listing-freq" value="frequent" ${currentFreq === 'frequent' ? 'checked' : ''} />
            <span>Frequent (every 15 min)</span>
          </label>
          ${devOption}
        </div>
      </div>
    `;

    this.marketplaceSwitch.setupEventListeners(contentContainer);
    this.timelineSwitch.setupEventListeners(contentContainer);

    // Frequency radio buttons
    contentContainer.querySelectorAll('input[name="listing-freq"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        const value = (e.target as HTMLInputElement).value;
        // Dev option stores raw string; production values are typed
        if (value === 'rare' || value === 'moderate' || value === 'frequent') {
          setTimelineListingFrequency(value);
        } else if (import.meta.env.DEV) {
          localStorage.setItem('noornote_marketplace_timeline_frequency', value);
        }
        EventBus.getInstance().emit('marketplace:timeline-frequency-change', { frequency: value });
        const labels: Record<string, string> = { rare: 'Rare (60 min)', moderate: 'Moderate (30 min)', frequent: 'Frequent (15 min)', dev: 'Dev (60s)' };
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
    if (this.timelineSwitch) {
      this.timelineSwitch.destroy();
      this.timelineSwitch = null;
    }
  }
}
