/**
 * MarketplaceSettingsSection
 * Toggle the Marketplace Add-On on/off.
 * Emits 'marketplace:toggle' so sidebar updates instantly (no reload needed).
 */

import { SettingsSection } from './SettingsSection';
import { Switch } from '../ui/Switch';
import { isMarketplaceEnabled, setMarketplaceEnabled } from '../../addons/marketplace/index';
import { EventBus } from '../../services/EventBus';

export class MarketplaceSettingsSection extends SettingsSection {
  private marketplaceSwitch: Switch | null = null;

  constructor() {
    super('marketplace-settings');
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    this.marketplaceSwitch = new Switch({
      label: 'Enable Marketplace',
      checked: isMarketplaceEnabled(),
      onChange: (checked) => {
        setMarketplaceEnabled(checked);
        EventBus.getInstance().emit('marketplace:toggle', { enabled: checked });
      }
    });

    contentContainer.innerHTML = `
      <div class="settings-field">
        <p class="settings-field__description">Browse classified listings (NIP-99) from the Nostr network. Adds a Marketplace entry to the sidebar.</p>
        ${this.marketplaceSwitch.render()}
      </div>
    `;

    this.marketplaceSwitch.setupEventListeners(contentContainer);
  }

  public unmount(): void {
    if (this.marketplaceSwitch) {
      this.marketplaceSwitch.destroy();
      this.marketplaceSwitch = null;
    }
  }
}
