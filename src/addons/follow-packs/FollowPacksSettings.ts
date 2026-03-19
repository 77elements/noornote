/**
 * FollowPacksSettings
 * Toggle the Follow Packs Add-On on/off.
 * Emits 'follow-packs:toggle' so sidebar updates instantly.
 */

import { SettingsSection } from '../../components/settings/SettingsSection';
import { Switch } from '../../components/ui/Switch';
import { isFollowPacksEnabled, setFollowPacksEnabled } from './index';
import { EventBus } from '../../services/EventBus';
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
      label: 'Enable Follow Packs',
      checked: isFollowPacksEnabled(),
      onChange: (checked) => {
        setFollowPacksEnabled(checked);
        EventBus.getInstance().emit('follow-packs:toggle', { enabled: checked });
        ToastService.show(checked ? 'Follow Packs enabled' : 'Follow Packs disabled', 'success');
      }
    });

    contentContainer.innerHTML = this.enableSwitch.render();
    this.enableSwitch.setupEventListeners(contentContainer);
  }

  public unmount(): void {
    if (this.enableSwitch) {
      this.enableSwitch.destroy();
      this.enableSwitch = null;
    }
  }
}
