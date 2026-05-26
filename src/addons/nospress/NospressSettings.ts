import { SettingsSection } from '../../components/settings/SettingsSection';
import { Switch } from '../../components/ui/Switch';
import { isNospressEnabled, setNospressEnabled } from './index';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';
import { NospressEnabledOrchestrator } from '../../services/orchestration/NospressEnabledOrchestrator';
import { AuthService } from '../../services/AuthService';

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
        TypedEventBus.getInstance().emit('nospress:addon-toggle', { enabled: checked });
        // Publish / delete the relay-visible opt-in marker so visitors
        // hitting `noornote.app/<handle>/` only see this user's space
        // after a deliberate enable. Fire-and-forget — local toggle
        // state still flips even if the relay round-trip is in-flight;
        // a failure surfaces in the toast.
        void this.syncEnabledMarker(checked);
        ToastService.show(checked ? 'NosPress enabled' : 'NosPress disabled', 'success');
      }
    });

    contentContainer.innerHTML = `
      <div class="setting">
        <span class="setting__label">Enable NosPress</span>
        <div class="setting__control">${this.enableSwitch.render()}</div>
        <p class="setting__desc">Build a public personal page at <code>noornote.app/&lt;your-nip-05-or-npub&gt;/</code> — pages, header / footer, navigation, custom CSS, fonts, theme. Stored as NIP-78 events on your own relays. Enabling this addon is your opt-in: a small marker event is published so visitors can find your space. Turning the toggle off deletes the marker — the route stops resolving for visitors. Your content events stay on relays unless you also wipe them via the Danger Zone in the editor.</p>
      </div>
    `;
    this.enableSwitch.setupEventListeners(contentContainer);
  }

  /** Mirror the local enable/disable toggle onto relays as a tiny
   *  NIP-78 opt-in marker. Publish on enable, kind:5 delete on disable.
   *  Silently no-ops when the user isn't authenticated yet — they can
   *  re-toggle once signed in to reach the relay-side. */
  private async syncEnabledMarker(enabled: boolean): Promise<void> {
    if (!AuthService.getInstance().getCurrentUser()) return;
    const orch = NospressEnabledOrchestrator.getInstance();
    try {
      if (enabled) {
        await orch.publishToRelays();
      } else {
        await orch.deleteFromRelays();
      }
    } catch (err) {
      console.error('Failed to sync NosPress opt-in marker', err);
      ToastService.show(
        enabled
          ? 'NosPress enabled locally, but the relay marker failed to publish'
          : 'NosPress disabled locally, but the relay marker failed to delete',
        'error',
      );
    }
  }

  public unmount(): void {
    if (this.enableSwitch) {
      this.enableSwitch.destroy();
      this.enableSwitch = null;
    }
  }
}
