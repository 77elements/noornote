import { SettingsSection } from '../../components/settings/SettingsSection';
import { Switch } from '../../components/ui/Switch';
import { ToastService } from '../../services/ToastService';
import { TypedEventBus } from '../../core/TypedEventBus';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
import { AddonLoader } from '../AddonLoader';
import { isGroupChatsEnabled, setGroupChatsEnabled, isArmadaEnabled, setArmadaEnabled } from './index';
import { GROUP_CHATS_INTERVAL_OPTIONS, GROUP_CHATS_DEFAULT_INTERVAL_MS } from './GroupChatsService';
import type { GroupChatsRuntime } from './runtime';

export class GroupChatsSettings extends SettingsSection {
  private enableSwitch: Switch | null = null;
  private armadaSwitch: Switch | null = null;
  private notifyOwnSwitch: Switch | null = null;
  private eventBus: TypedEventBus;
  private storage: PerAccountLocalStorage;
  private contentZone: HTMLElement | null = null;

  constructor() {
    super('group-chats-settings');
    this.eventBus = TypedEventBus.getInstance();
    this.storage = PerAccountLocalStorage.getInstance();
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    this.contentZone = parentContainer.querySelector('[data-addon-content="group-chats"]');

    const groupChatsEnabled = isGroupChatsEnabled();
    const armadaEnabled = isArmadaEnabled();

    this.enableSwitch = new Switch({
      label: '',
      checked: groupChatsEnabled,
      onChange: (checked) => { void this.handleToggle(checked); }
    });

    this.armadaSwitch = new Switch({
      label: '',
      checked: armadaEnabled,
      onChange: (checked) => { void this.handleArmadaToggle(checked); }
    });

    contentContainer.innerHTML = `
      <div class="setting">
        <span class="setting__label">Enable Nostrord <span class="form__note">(beta)</span></span>
        <div class="setting__control">${this.enableSwitch.render()}</div>
        <p class="setting__desc">Get a heads-up when one of your Nostrord (NIP-29) groups comes alive.
          NoorNote checks your groups on a schedule and, if anything was posted in that window, drops a
          single low-priority notification per group. A quiet group stays quiet.</p>
      </div>
      <div class="setting">
        <span class="setting__label">Enable Armada <span class="form__note">(beta)</span></span>
        <div class="setting__control">${this.armadaSwitch.render()}</div>
        <p class="setting__desc">Same idea, for Armada (Concord) end-to-end encrypted communities.
          Toggle this on to opt in to future activity notifications from your tracked Armada communities.
          NoorNote already shows Armada invite cards inline in your feed; community-message polling is in
          active development.</p>
      </div>
    `;
    this.enableSwitch.setupEventListeners(contentContainer);
    this.armadaSwitch.setupEventListeners(contentContainer);

    // The check-frequency + notify-own settings below are shared across all
    // enabled providers (today: GroupChats + Armada; tomorrow: Meshcat etc.).
    // Render them if at least one provider is on.
    this.renderPanel(groupChatsEnabled || armadaEnabled);
  }

  private async handleToggle(checked: boolean): Promise<void> {
    setGroupChatsEnabled(checked);
    this.eventBus.emit('group-chats:addon-toggle', { enabled: checked });
    ToastService.show(checked ? 'Nostrord enabled' : 'Nostrord disabled', 'success');
    this.renderPanel(isGroupChatsEnabled() || isArmadaEnabled());
  }

  private async handleArmadaToggle(checked: boolean): Promise<void> {
    setArmadaEnabled(checked);
    this.eventBus.emit('armada:addon-toggle', { enabled: checked });
    ToastService.show(checked ? 'Armada enabled (polling coming soon)' : 'Armada disabled', 'success');
    this.renderPanel(isGroupChatsEnabled() || isArmadaEnabled());
  }

  private getCurrentInterval(): number {
    return this.storage.get<number>(StorageKeys.GROUP_CHATS_POLL_INTERVAL, GROUP_CHATS_DEFAULT_INTERVAL_MS);
  }

  private getNotifyOwn(): boolean {
    return this.storage.get<boolean>(StorageKeys.GROUP_CHATS_NOTIFY_OWN_POSTS, true);
  }

  private renderPanel(enabled: boolean): void {
    if (!this.contentZone) return;
    this.notifyOwnSwitch?.destroy();
    this.notifyOwnSwitch = null;
    if (!enabled) { this.contentZone.innerHTML = ''; return; }

    const current = this.getCurrentInterval();
    const optionsHtml = GROUP_CHATS_INTERVAL_OPTIONS.map(option => `
      <label class="nn-checkbox nn-checkbox--label-left">
        <span class="setting__label">${option.label}</span>
        <input
          type="radio"
          name="group-chats-interval"
          value="${option.value}"
          ${option.value === current ? 'checked' : ''}
        />
      </label>
    `).join('');

    this.notifyOwnSwitch = new Switch({
      label: '',
      checked: this.getNotifyOwn(),
      onChange: (checked) => {
        this.storage.set(StorageKeys.GROUP_CHATS_NOTIFY_OWN_POSTS, checked);
        ToastService.show(
          checked ? 'GroupChats: your own posts included' : 'GroupChats: your own posts excluded',
          'success'
        );
      }
    });

    this.contentZone.innerHTML = `
      <section class="section group-chats-settings">
        <div class="setting">
          <label class="setting__label">Check frequency</label>
          <p class="setting__desc">How often to look for new activity across all your enabled group chat
            providers (GroupChats, Armada, and future ones). This window is also the quiet period: after one
            notification, the same group won't notify again until the next check.</p>
          <div class="mode-options">
            ${optionsHtml}
          </div>
        </div>
        <div class="setting">
          <span class="setting__label">Notify me about my own posts</span>
          <div class="setting__control">${this.notifyOwnSwitch.render()}</div>
          <p class="setting__desc">Also get the heads-up when you post to a group yourself — a handy
            cross-device confirmation that your message went through. Turn off to only hear about others.
            Applies to every enabled provider.</p>
        </div>
      </section>
    `;

    this.contentZone.querySelectorAll<HTMLInputElement>('input[name="group-chats-interval"]').forEach(input => {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        const intervalMs = Number(input.value);
        this.storage.set(StorageKeys.GROUP_CHATS_POLL_INTERVAL, intervalMs);
        const rt = AddonLoader.getInstance().getRuntime<GroupChatsRuntime>('group-chats');
        rt?.service?.setPollingInterval(intervalMs);
        const label = GROUP_CHATS_INTERVAL_OPTIONS.find(o => o.value === intervalMs)?.label ?? 'updated';
        ToastService.show(`Group Chats: ${label.toLowerCase()}`, 'success');
      });
    });

    this.notifyOwnSwitch.setupEventListeners(this.contentZone);
  }

  public unmount(): void {
    this.enableSwitch?.destroy();
    this.enableSwitch = null;
    this.armadaSwitch?.destroy();
    this.armadaSwitch = null;
    this.notifyOwnSwitch?.destroy();
    this.notifyOwnSwitch = null;
    this.contentZone = null;
  }
}
