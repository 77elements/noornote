/**
 * FollowPacksSettings
 * Toggle the Follow Packs Add-On on/off.
 * Emits 'follow-packs:toggle' so sidebar updates instantly.
 */

import { SettingsSection } from '../../components/settings/SettingsSection';
import { Switch } from '../../components/ui/Switch';
import { isFollowPacksEnabled, setFollowPacksEnabled } from './index';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';

export class FollowPacksSettings extends SettingsSection {
  private enableSwitch: Switch | null = null;

  constructor() {
    super('follow-packs-settings');
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    this.enableSwitch = new Switch({
      label: '',
      checked: isFollowPacksEnabled(),
      onChange: (checked) => {
        setFollowPacksEnabled(checked);
        // Emit the uniform AddonLoader event + the legacy event so
        // FollowPacksView's existing listener keeps working.
        const bus = TypedEventBus.getInstance();
        bus.emit('follow-packs:addon-toggle', { enabled: checked });
        bus.emit('follow-packs:toggle', { enabled: checked });
        ToastService.show(checked ? 'Follow Packs enabled' : 'Follow Packs disabled', 'success');
      }
    });

    contentContainer.innerHTML = `
      <div class="setting">
        <span class="setting__label">Enable Follow Packs</span>
        <div class="setting__control">${this.enableSwitch.render()}</div>
        <p class="setting__desc">Discover and share curated lists of Nostr users to follow. Find the users that are most interesting to you or create your own lists.</p>
      </div>
    `;
    this.enableSwitch.setupEventListeners(contentContainer);
  }

  public unmount(): void {
    if (this.enableSwitch) {
      this.enableSwitch.destroy();
      this.enableSwitch = null;
    }
  }
}
