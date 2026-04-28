import { SettingsSection } from '../../components/settings/SettingsSection';
import { Switch } from '../../components/ui/Switch';
import { isMypageEnabled, setMypageEnabled } from './index';
import { EventBus } from '../../services/EventBus';
import { ToastService } from '../../services/ToastService';

export class MypageSettings extends SettingsSection {
  private enableSwitch: Switch | null = null;

  constructor() {
    super('mypage-settings');
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    this.enableSwitch = new Switch({
      label: '',
      checked: isMypageEnabled(),
      onChange: (checked) => {
        setMypageEnabled(checked);
        EventBus.getInstance().emit('mypage:toggle', { enabled: checked });
        ToastService.show(checked ? 'My Page enabled' : 'My Page disabled', 'success');
      }
    });

    contentContainer.innerHTML = `
      <div class="setting">
        <span class="setting__label">Enable My Page</span>
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
