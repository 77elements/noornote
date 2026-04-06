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
      label: '',
      checked: isNostrInEnabled(),
      onChange: (checked) => {
        setNostrInEnabled(checked);
        EventBus.getInstance().emit('nostrin:toggle', { enabled: checked });
        ToastService.show(checked ? 'NostrIn enabled' : 'NostrIn disabled', 'success');
      }
    });

    contentContainer.innerHTML = `
      <div class="setting">
        <span class="setting__label">Enable NostrIn</span>
        <div class="setting__control">${this.enableSwitch.render()}</div>
        <p class="setting__desc">Mount a bookmark folder or a custom list of users to your own profile so other NoorNote users can see them. Client-side only — nothing is published to relays.</p>
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
