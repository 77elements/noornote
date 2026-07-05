import { SettingsSection } from '../../components/settings/SettingsSection';
import { Switch } from '../../components/ui/Switch';
import { ToastService } from '../../services/ToastService';
import { TypedEventBus } from '../../core/TypedEventBus';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
import { AddonLoader } from '../AddonLoader';
import { isNostrordEnabled, setNostrordEnabled } from './index';
import { NOSTRORD_INTERVAL_OPTIONS, NOSTRORD_DEFAULT_INTERVAL_MS } from './NostrordService';
import type { NostrordRuntime } from './runtime';

export class NostrordSettings extends SettingsSection {
  private enableSwitch: Switch | null = null;
  private eventBus: TypedEventBus;
  private storage: PerAccountLocalStorage;
  private contentZone: HTMLElement | null = null;

  constructor() {
    super('nostrord-settings');
    this.eventBus = TypedEventBus.getInstance();
    this.storage = PerAccountLocalStorage.getInstance();
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    this.contentZone = parentContainer.querySelector('[data-addon-content="nostrord"]');

    const enabled = isNostrordEnabled();

    this.enableSwitch = new Switch({
      label: '',
      checked: enabled,
      onChange: (checked) => { void this.handleToggle(checked); }
    });

    contentContainer.innerHTML = `
      <div class="setting">
        <span class="setting__label">Enable Nostrord <span class="form__note">(beta)</span></span>
        <div class="setting__control">${this.enableSwitch.render()}</div>
        <p class="setting__desc">Get a heads-up when one of your Nostrord (NIP-29) groups comes alive.
          NoorNote checks your groups on a schedule and, if anything was posted in that window, drops a
          single low-priority notification per group. A quiet group stays quiet.</p>
      </div>
    `;
    this.enableSwitch.setupEventListeners(contentContainer);

    this.renderPanel(enabled);
  }

  private async handleToggle(checked: boolean): Promise<void> {
    setNostrordEnabled(checked);
    this.eventBus.emit('nostrord:addon-toggle', { enabled: checked });
    ToastService.show(checked ? 'Nostrord enabled' : 'Nostrord disabled', 'success');
    this.renderPanel(checked);
  }

  private getCurrentInterval(): number {
    return this.storage.get<number>(StorageKeys.NOSTRORD_POLL_INTERVAL, NOSTRORD_DEFAULT_INTERVAL_MS);
  }

  private renderPanel(enabled: boolean): void {
    if (!this.contentZone) return;
    if (!enabled) { this.contentZone.innerHTML = ''; return; }

    const current = this.getCurrentInterval();
    const optionsHtml = NOSTRORD_INTERVAL_OPTIONS.map(option => `
      <label class="nn-checkbox nn-checkbox--label-left">
        <span class="setting__label">${option.label}</span>
        <input
          type="radio"
          name="nostrord-interval"
          value="${option.value}"
          ${option.value === current ? 'checked' : ''}
        />
      </label>
    `).join('');

    this.contentZone.innerHTML = `
      <section class="section nostrord-settings">
        <div class="setting">
          <label class="setting__label">Check frequency</label>
          <p class="setting__desc">How often to look for new activity in your groups. This window is also
            the quiet period: after one notification, the same group won't notify again until the next check.</p>
          <div class="mode-options">
            ${optionsHtml}
          </div>
        </div>
      </section>
    `;

    this.contentZone.querySelectorAll<HTMLInputElement>('input[name="nostrord-interval"]').forEach(input => {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        const intervalMs = Number(input.value);
        this.storage.set(StorageKeys.NOSTRORD_POLL_INTERVAL, intervalMs);
        const rt = AddonLoader.getInstance().getRuntime<NostrordRuntime>('nostrord');
        rt?.service?.setPollingInterval(intervalMs);
        const label = NOSTRORD_INTERVAL_OPTIONS.find(o => o.value === intervalMs)?.label ?? 'updated';
        ToastService.show(`Nostrord: ${label.toLowerCase()}`, 'success');
      });
    });
  }

  public unmount(): void {
    this.enableSwitch?.destroy();
    this.enableSwitch = null;
    this.contentZone = null;
  }
}
