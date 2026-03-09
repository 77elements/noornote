/**
 * MarketplaceSettingsSection
 * Toggle the Marketplace Add-On on/off.
 * Requires page reload to register/unregister routes.
 */

import { SettingsSection } from './SettingsSection';
import { Switch } from '../ui/Switch';
import { isMarketplaceEnabled, setMarketplaceEnabled } from '../../marketplace/index';
import { ToastService } from '../../services/ToastService';

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
        ToastService.show(
          checked
            ? 'Marketplace enabled — reload to activate'
            : 'Marketplace disabled — reload to deactivate',
          'success'
        );
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
