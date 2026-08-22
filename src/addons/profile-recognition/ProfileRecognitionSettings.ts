/**
 * ProfileRecognitionSettings Component
 * Manages profile recognition feature configuration
 *
 * @purpose Configure recognition window for profile changes
 * @used-by SettingsView
 */

import { SettingsSection } from '../../components/settings/SettingsSection';
import { Switch } from '../../components/ui/Switch';
import { ToastService } from '../../services/ToastService';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';
import { TypedEventBus } from '../../core/TypedEventBus';

// Window values: 0 = disabled, -1 = always, or number of days
const WINDOW_OPTIONS = [
  {
    value: 1,
    label: '1 Day',
    description: 'Show for 1 day after profile changes',
  },
  {
    value: 7,
    label: '7 Days',
    description: 'Show for 1 week after profile changes',
  },
  {
    value: 30,
    label: '30 Days',
    description: 'Show for 1 month after profile changes',
  },
  {
    value: 90,
    label: '90 Days (Default)',
    description: 'Show for 3 months after profile changes',
  },
  {
    value: -1,
    label: 'Always',
    description: 'Always show profile change indicators',
  },
];

export class ProfileRecognitionSettings extends SettingsSection {
  private enableSwitch: Switch | null = null;

  constructor() {
    super('profile-recognition-settings');
  }

  private getCurrentWindow(): number {
    return PerAccountLocalStorage.getInstance().get<number>(
      StorageKeys.PROFILE_RECOGNITION_WINDOW,
      90
    );
  }

  /**
   * Save the recognition window AND notify the AddonLoader if the enabled-state
   * transitions (0 ↔ non-zero). The AddonLoader listens on
   * 'profile-recognition:addon-toggle' to dynamically load/destroy the runtime.
   */
  private saveWindow(value: number): void {
    const prev = this.getCurrentWindow();
    const wasEnabled = prev !== 0;
    const nowEnabled = value !== 0;
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.PROFILE_RECOGNITION_WINDOW,
      value
    );
    if (wasEnabled !== nowEnabled) {
      TypedEventBus.getInstance().emit('profile-recognition:addon-toggle', {
        enabled: nowEnabled,
      });
    }
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    const currentWindow = this.getCurrentWindow();
    const enabled = currentWindow !== 0;

    this.enableSwitch = new Switch({
      label: '',
      checked: enabled,
      onChange: checked => {
        if (checked) {
          this.saveWindow(90);
          ToastService.show('Profile Recognition enabled (90 days)', 'success');
        } else {
          this.saveWindow(0);
          ToastService.show('Profile Recognition disabled', 'success');
        }
        // Show/hide options in content zone
        const options = parentContainer.querySelector(
          '.profile-recognition-options'
        ) as HTMLElement | null;
        if (options) options.style.display = checked ? '' : 'none';
      },
    });

    const optionsHtml = WINDOW_OPTIONS.map(option => {
      const isChecked = option.value === currentWindow;
      return `
        <label class="nn-checkbox nn-checkbox--label-left">
          <span class="setting__label">${option.label}</span>
          <input
            type="radio"
            name="profile-recognition-window"
            value="${option.value}"
            ${isChecked ? 'checked' : ''}
          />
        </label>
      `;
    }).join('');

    contentContainer.innerHTML = `
      <div class="setting">
        <span class="setting__label">Enable Profile Recognition</span>
        <div class="setting__control">${this.enableSwitch.render()}</div>
        <p class="setting__desc">Helps you recognize people you follow even after they change their name or profile picture. When someone you follow changes their profile, the app shows visual cues (blinking profile pictures) so you remember who they are.</p>
      </div>
    `;

    this.enableSwitch.setupEventListeners(contentContainer);

    // Mount the rest into the addon's content zone (below the settings section)
    const contentZone = parentContainer.querySelector(
      '[data-addon-content="profile-recognition"]'
    ) as HTMLElement | null;
    if (contentZone) {
      contentZone.innerHTML = `
        <div class="profile-recognition-options" style="${enabled ? '' : 'display: none'}">
          <p>Choose how long to show these recognition cues after a profile change:</p>

          <div class="mode-options">
            ${optionsHtml}
          </div>

          <h2>How it works</h2>
          <ul>
            <li>When you follow someone, the app saves their current name and profile picture</li>
            <li>If they change their profile within your selected window, their picture will blink between old and new</li>
            <li>After the window expires, the blinking stops (you've adapted to their new profile)</li>
            <li>Only applies to people you follow (not everyone you see)</li>
          </ul>
        </div>
      `;
      this.bindListeners(contentZone);
    }
  }

  private bindListeners(contentContainer: HTMLElement): void {
    const radioInputs = contentContainer.querySelectorAll<HTMLInputElement>(
      'input[name="profile-recognition-window"]'
    );
    const modeOptions = contentContainer.querySelectorAll('.mode-option');

    radioInputs.forEach(input => {
      input.addEventListener('change', () => {
        if (input.checked) {
          modeOptions.forEach(opt =>
            opt.classList.remove('mode-option--active')
          );
          input.closest('.mode-option')?.classList.add('mode-option--active');

          const value = parseInt(input.value, 10);
          this.saveWindow(value);

          const message =
            value === -1
              ? 'Profile Recognition set to Always'
              : `Profile Recognition set to ${value} day${value > 1 ? 's' : ''}`;
          ToastService.show(message, 'success');
        }
      });
    });
  }

  public unmount(): void {
    if (this.enableSwitch) {
      this.enableSwitch.destroy();
      this.enableSwitch = null;
    }
  }
}
