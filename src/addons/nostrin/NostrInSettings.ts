import { SettingsSection } from '../../components/settings/SettingsSection';
import { Switch } from '../../components/ui/Switch';
import { isNostrInEnabled, setNostrInEnabled } from './index';
import { EventBus } from '../../services/EventBus';
import { ToastService } from '../../services/ToastService';

export class NostrInSettings extends SettingsSection {
  private enableSwitch: Switch | null = null;

  constructor() {
    super('nostrin-settings');
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    this.enableSwitch = new Switch({
      label: 'Enable NostrIn',
      checked: isNostrInEnabled(),
      onChange: (checked) => {
        setNostrInEnabled(checked);
        EventBus.getInstance().emit('nostrin:toggle', { enabled: checked });
        ToastService.show(checked ? 'NostrIn enabled' : 'NostrIn disabled', 'success');
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
