/**
 * WavlakePlayerSettingsSection
 * Toggle the Wavlake Player add-on on/off, plus the op3.dev play-stats opt-in.
 * Emits 'wavlake-player:addon-toggle' so the AddonLoader + sidebar react instantly.
 */

import { SettingsSection } from './SettingsSection';
import { Switch } from '../ui/Switch';
import {
  isWavlakePlayerEnabled, setWavlakePlayerEnabled,
  isWavlakeKeepOp3Enabled, setWavlakeKeepOp3Enabled,
} from '../../addons/wavlake-player/index';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';

export class WavlakePlayerSettingsSection extends SettingsSection {
  private enableSwitch: Switch | null = null;
  private op3Switch: Switch | null = null;

  constructor() {
    super('wavlake-player-settings');
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    const enabled = isWavlakePlayerEnabled();

    this.enableSwitch = new Switch({
      label: '',
      checked: enabled,
      onChange: (checked) => {
        setWavlakePlayerEnabled(checked);
        TypedEventBus.getInstance().emit('wavlake-player:addon-toggle', { enabled: checked });
        this.updateOp3Visibility(contentContainer);
        ToastService.show(checked ? 'Wavlake Player enabled' : 'Wavlake Player disabled', 'success');
      }
    });

    this.op3Switch = new Switch({
      label: '',
      checked: isWavlakeKeepOp3Enabled(),
      onChange: (checked) => {
        setWavlakeKeepOp3Enabled(checked);
        ToastService.show(
          checked ? 'Keeping op3.dev play-stats — your IP is shared on Play' : 'Stripping op3.dev — maximum privacy',
          'success'
        );
      }
    });

    contentContainer.innerHTML = `
      <div class="setting">
        <span class="setting__label">Enable Wavlake Player</span>
        <div class="setting__control">${this.enableSwitch.render()}</div>
        <p class="setting__desc">Render wavlake.com track links as an inline player (cover, artist, play).</p>
      </div>

      <div class="wavlake-op3-setting${enabled ? '' : ' is-hidden'}">
        <div class="setting">
          <span class="setting__label">Keep op3.dev play-stats</span>
          <div class="setting__control">${this.op3Switch.render()}</div>
          <p class="setting__desc">Off (default): the mp3 loads directly from Wavlake's CDN — maximum privacy. On: playback routes through op3.dev so the artist gets play statistics, but your IP is shared with op3.dev when you press Play.</p>
        </div>
      </div>
    `;

    this.enableSwitch.setupEventListeners(contentContainer);
    this.op3Switch.setupEventListeners(contentContainer);
  }

  private updateOp3Visibility(container: HTMLElement): void {
    container.querySelector('.wavlake-op3-setting')?.classList.toggle('is-hidden', !isWavlakePlayerEnabled());
  }

  public unmount(): void {
    if (this.enableSwitch) {
      this.enableSwitch.destroy();
      this.enableSwitch = null;
    }
    if (this.op3Switch) {
      this.op3Switch.destroy();
      this.op3Switch = null;
    }
  }
}
