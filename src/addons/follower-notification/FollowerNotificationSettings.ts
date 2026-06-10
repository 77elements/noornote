import { SettingsSection } from '../../components/settings/SettingsSection';
import { Switch } from '../../components/ui/Switch';
import { ToastService } from '../../services/ToastService';
import { ModalService } from '../../services/ModalService';
import { isDataSaverEnabled } from '../../services/DataSaverService';
import { TypedEventBus } from '../../core/TypedEventBus';
import { AddonLoader } from '../AddonLoader';
import { UserIdentity } from '../../components/shared/UserIdentity';
import { formatTimeAgo } from '../../helpers/formatTimeAgo';
import { escapeHtml } from '../../helpers/escapeHtml';
import { FollowerSnapshotStorage, DEFAULT_RECENCY_DAYS, type FollowerChange } from '../../lists/FollowerSnapshotStorage';
import { isFollowerNotificationEnabled, setFollowerNotificationEnabled } from './index';
import type { FollowerNotificationRuntime } from './runtime';

export class FollowerNotificationSettings extends SettingsSection {
  private enableSwitch: Switch | null = null;
  private eventBus: TypedEventBus;
  private storage: FollowerSnapshotStorage;
  private contentZone: HTMLElement | null = null;
  private identities: UserIdentity[] = [];
  private subIds: string[] = [];

  constructor() {
    super('follower-notification-settings');
    this.eventBus = TypedEventBus.getInstance();
    this.storage = FollowerSnapshotStorage.getInstance();
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    this.contentZone = parentContainer.querySelector('[data-addon-content="follower-notification"]');

    const enabled = isFollowerNotificationEnabled();

    this.enableSwitch = new Switch({
      label: '',
      checked: enabled,
      onChange: (checked) => { void this.handleToggle(checked); }
    });

    contentContainer.innerHTML = `
      <div class="setting">
        <span class="setting__label">Enable Follower Notification</span>
        <div class="setting__control">${this.enableSwitch.render()}</div>
        <p class="setting__desc">Get notified when someone new follows you. Checks every 3 hours in the
          background; each new follower is verified against their own contact list, so there are no false alarms.</p>
      </div>
    `;
    this.enableSwitch.setupEventListeners(contentContainer);

    // Re-render the panel whenever a check finds changes or they're marked seen.
    this.subIds.push(this.eventBus.on('follower-changes:detected', () => this.renderPanel(isFollowerNotificationEnabled())));
    this.subIds.push(this.eventBus.on('follower-changes:seen', () => this.renderPanel(isFollowerNotificationEnabled())));

    this.renderPanel(enabled);
  }

  /**
   * Enabling on mobile while Data Saver is on is a conflict: the addon's baseline sweep ignores
   * Data Saver (forces the full relay set so it doesn't miss followers) and pulls a few MB. Get
   * informed consent before turning it on; if declined, revert the switch and stay off.
   */
  private async handleToggle(checked: boolean): Promise<void> {
    if (checked && isDataSaverEnabled()) {
      const proceed = await ModalService.getInstance().confirm({
        title: 'Conflicts with Data Saver',
        message: 'Data Saver is on. To find followers reliably this addon ignores it for its scan: a ' +
          'one-time pull of all your followers’ contact lists (a few MB), then small background ' +
          'checks every few hours. Enable anyway?',
        confirmText: 'Enable anyway',
        cancelText: 'Keep off'
      });
      if (!proceed) {
        this.enableSwitch?.setChecked(false);
        return;
      }
    }

    setFollowerNotificationEnabled(checked);
    this.eventBus.emit('follower-notification:addon-toggle', { enabled: checked });
    ToastService.show(
      checked ? 'Follower Notification enabled' : 'Follower Notification disabled',
      'success'
    );
    this.renderPanel(checked);
  }

  private getService(): FollowerNotificationRuntime['service'] | null {
    const rt = AddonLoader.getInstance().getRuntime<FollowerNotificationRuntime>('follower-notification');
    return rt?.service ?? null;
  }

  private renderPanel(enabled: boolean): void {
    this.disposeIdentities();
    if (!this.contentZone) return;

    if (!enabled) {
      this.contentZone.innerHTML = '';
      return;
    }

    const snapshot = this.storage.getSnapshot();
    const followerCount = snapshot?.followerPubkeys.length ?? null;
    const warmingUp = !this.storage.isWarmupComplete();
    const lastCheck = this.storage.getLastCheckTimestamp();
    const changes = this.storage.getChanges();

    const statusText = followerCount === null
      ? 'No baseline yet — the first check runs a few minutes after start.'
      : warmingUp
        ? `Calibrating baseline (${followerCount.toLocaleString('en-US')} followers)…`
        : `Watching ${followerCount.toLocaleString('en-US')} followers for changes.`;

    const lastCheckText = lastCheck ? `Last checked ${formatTimeAgo(lastCheck)}.` : '';
    const recencyDays = this.storage.getRecencyDays();

    this.contentZone.innerHTML = `
      <section class="section follower-notification">
        <div class="l-spread">
          <div>
            <p class="follower-notification__status">${escapeHtml(statusText)}</p>
            <p class="form__note follower-notification__last-check">${escapeHtml(lastCheckText)}</p>
          </div>
          <div>
            <button class="btn" data-action="check-now">Check now</button>
          </div>
        </div>
        <div class="setting follower-notification__recency">
          <label class="setting__label" for="fn-recency-input">Count a follow as &quot;new&quot; for (days)</label>
          <div class="setting__control">
            <input class="input" id="fn-recency-input" type="number" min="1" max="365" step="1" value="${recencyDays}" data-action="recency" />
          </div>
          <p class="setting__desc">A follower whose contact list (including you) was last published longer ago than this is treated as a long-standing follower discovered late — added to the baseline silently, no notification.</p>
        </div>
        ${changes.length > 0 ? `
          <div class="l-spread follower-notification__changes-head">
            <strong>Recent changes (${changes.length})</strong>
            <button class="btn btn--passive btn--mini" data-action="mark-seen">Mark all seen</button>
          </div>
          <div class="ui-list follower-notification__list"></div>
        ` : `<p class="form__note">No changes detected yet.</p>`}
      </section>
    `;

    const checkBtn = this.contentZone.querySelector('[data-action="check-now"]') as HTMLButtonElement | null;
    checkBtn?.addEventListener('click', () => this.handleCheckNow(checkBtn));

    const markBtn = this.contentZone.querySelector('[data-action="mark-seen"]');
    markBtn?.addEventListener('click', () => this.handleMarkSeen());

    const recencyInput = this.contentZone.querySelector('[data-action="recency"]') as HTMLInputElement | null;
    recencyInput?.addEventListener('change', () => {
      const days = Math.max(1, Math.min(365, Math.round(Number(recencyInput.value) || DEFAULT_RECENCY_DAYS)));
      recencyInput.value = String(days);
      this.storage.setRecencyDays(days);
      ToastService.show(`New-follower window: ${days} day${days === 1 ? '' : 's'}`, 'success');
    });

    const list = this.contentZone.querySelector('.follower-notification__list');
    if (list) {
      // Newest first.
      [...changes].sort((a, b) => b.detectedAt - a.detectedAt).forEach(c => list.appendChild(this.renderChangeRow(c)));
    }
  }

  private renderChangeRow(change: FollowerChange): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ui-list__item follower-notification__item';

    const identity = new UserIdentity({ pubkey: change.pubkey, size: 'medium', showHandle: true, clickable: true });
    this.identities.push(identity);
    row.appendChild(identity.getElement());

    const label = document.createElement('span');
    label.className = 'follower-notification__tag follower-notification__tag--new';
    label.textContent = 'now follows you';
    row.appendChild(label);

    return row;
  }

  private async handleCheckNow(btn: HTMLButtonElement): Promise<void> {
    const service = this.getService();
    if (!service) {
      ToastService.show('Addon is still starting up — try again in a moment', 'info');
      return;
    }
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Checking…';
    btn.classList.add('pulsate');
    try {
      await service.runCheck();
      this.renderPanel(true);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
      btn.classList.remove('pulsate');
    }
  }

  private async handleMarkSeen(): Promise<void> {
    const service = this.getService();
    if (service) {
      await service.markAsSeen();
    }
    this.renderPanel(isFollowerNotificationEnabled());
  }

  private disposeIdentities(): void {
    this.identities.forEach(i => i.destroy());
    this.identities = [];
  }

  public unmount(): void {
    this.subIds.forEach(id => this.eventBus.off(id));
    this.subIds = [];
    this.disposeIdentities();
    this.enableSwitch = null;
    this.contentZone = null;
  }
}
