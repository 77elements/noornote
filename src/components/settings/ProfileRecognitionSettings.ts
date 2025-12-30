/**
 * ProfileRecognitionSettings Component
 * Manages profile recognition feature configuration
 *
 * @purpose Configure recognition window for profile changes
 * @used-by SettingsView
 */

import { SettingsSection } from './SettingsSection';
import { ToastService } from '../../services/ToastService';

const STORAGE_KEY = 'noornote_profile_recognition_window';

// Window values: 0 = disabled, -1 = always, or number of days
const WINDOW_OPTIONS = [
  { value: 0, label: 'Disabled', description: 'Never show profile change indicators' },
  { value: 1, label: '1 Day', description: 'Show for 1 day after profile changes' },
  { value: 7, label: '7 Days', description: 'Show for 1 week after profile changes' },
  { value: 30, label: '30 Days', description: 'Show for 1 month after profile changes' },
  { value: 90, label: '90 Days (Default)', description: 'Show for 3 months after profile changes' },
  { value: -1, label: 'Always', description: 'Always show profile change indicators' }
];

export class ProfileRecognitionSettings extends SettingsSection {
  private toastService: ToastService;

  constructor() {
    super('profile-recognition-settings');
    this.toastService = ToastService.getInstance();
  }

  /**
   * Get current window setting from localStorage
   */
  private getCurrentWindow(): number {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return 90; // Default: 90 days

      const value = parseInt(stored, 10);
      return isNaN(value) ? 90 : value;
    } catch {
      return 90;
    }
  }

  /**
   * Save window setting to localStorage
   */
  private saveWindow(value: number): void {
    localStorage.setItem(STORAGE_KEY, value.toString());
  }

  /**
   * Mount section content into the DOM
   */
  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    contentContainer.innerHTML = this.renderContent();
    this.bindListeners(contentContainer);
  }

  /**
   * Render profile recognition settings content
   */
  private renderContent(): string {
    const currentWindow = this.getCurrentWindow();

    const optionsHtml = WINDOW_OPTIONS.map(option => {
      const isChecked = option.value === currentWindow;
      return `
        <div class="radio-option">
          <label class="radio-label">
            <input
              type="radio"
              name="profile-recognition-window"
              value="${option.value}"
              ${isChecked ? 'checked' : ''}
              class="radio-input"
            />
            <span class="radio-label-text">
              <strong>${option.label}</strong>
              <span class="radio-description">${option.description}</span>
            </span>
          </label>
        </div>
      `;
    }).join('');

    return `
      <div class="profile-recognition-settings">
        <div class="form__info">
          <p>
            Profile Recognition helps you recognize people you follow even after they change their name or profile picture.
            When someone you follow changes their profile, the app will show visual cues (blinking profile pictures) to help you remember who they are.
          </p>
          <p style="margin-top: 0.75rem;">
            Choose how long to show these recognition cues after a profile change:
          </p>
        </div>

        <div class="radio-group">
          ${optionsHtml}
        </div>

        <div class="form__info" style="margin-top: 1.5rem;">
          <p style="font-size: 13px; color: rgba(255, 255, 255, 0.6);">
            <strong>How it works:</strong><br>
            • When you follow someone, the app saves their current name and profile picture<br>
            • If they change their profile within your selected window, their picture will blink between old and new<br>
            • After the window expires, the blinking stops (you've adapted to their new profile)<br>
            • Only applies to people you follow (not everyone you see)
          </p>
        </div>
      </div>
    `;
  }

  /**
   * Bind event listeners
   */
  private bindListeners(contentContainer: HTMLElement): void {
    const radioInputs = contentContainer.querySelectorAll<HTMLInputElement>('input[name="profile-recognition-window"]');

    radioInputs.forEach(input => {
      input.addEventListener('change', () => {
        if (input.checked) {
          const value = parseInt(input.value, 10);
          this.saveWindow(value);

          // Show toast based on selection
          let message = 'Profile Recognition updated';
          if (value === 0) {
            message = 'Profile Recognition disabled';
          } else if (value === -1) {
            message = 'Profile Recognition set to Always';
          } else {
            message = `Profile Recognition set to ${value} day${value > 1 ? 's' : ''}`;
          }

          this.toastService.show(message, 'success');
        }
      });
    });
  }

  /**
   * Unmount section and cleanup
   */
  public unmount(): void {
    // No cleanup needed
  }
}
