import { SettingsSection } from '../../components/settings/SettingsSection';
import { Switch } from '../../components/ui/Switch';
import { isNospressEnabled, setNospressEnabled } from './index';
import { EventBus } from '../../services/EventBus';
import { ToastService } from '../../services/ToastService';

export class NospressSettings extends SettingsSection {
  private enableSwitch: Switch | null = null;

  constructor() {
    super('nospress-settings');
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    this.enableSwitch = new Switch({
      label: '',
      checked: isNospressEnabled(),
      onChange: (checked) => {
        setNospressEnabled(checked);
        EventBus.getInstance().emit('nospress:toggle', { enabled: checked });
        ToastService.show(checked ? 'NosPress enabled' : 'NosPress disabled', 'success');
      }
    });

    contentContainer.innerHTML = `
      <div class="setting">
        <span class="setting__label">Enable NosPress</span>
        <div class="setting__control">${this.enableSwitch.render()}</div>
        <p class="setting__desc">Mount bookmark folders or a custom list to your profile so other NoorNote users can see them. Stored as NIP-78 events on your relays — anyone can read them, only you can publish them.</p>
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
