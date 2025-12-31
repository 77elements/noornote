/**
 * UISettingsSection Component
 * Manages UI-related settings (experimental view navigation features, calendar system)
 *
 * @purpose Configure UI behavior and experimental features
 * @used-by SettingsView
 */

import { SettingsSection } from './SettingsSection';
import { Switch } from '../ui/Switch';
import { CustomDropdown } from '../ui/CustomDropdown';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
import { ToastService } from '../../services/ToastService';
import { EventBus } from '../../services/EventBus';

export class UISettingsSection extends SettingsSection {
  private storage: PerAccountLocalStorage;
  private eventBus: EventBus;
  private viewTabsSwitch: Switch | null = null;
  private calendarDropdown: CustomDropdown | null = null;

  constructor() {
    super('ui-settings');
    this.storage = PerAccountLocalStorage.getInstance();
    this.eventBus = EventBus.getInstance();
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
   * Render UI settings content
   */
  private renderContent(): string {
    return `
      <div class="ui-settings">
        <h3 class="subsection-title">Calendar System</h3>
        <div class="form__info">
          <p>Choose how dates are displayed throughout the app.</p>
        </div>

        <div class="form-group">
          <label class="form-label">Date Format</label>
          <div class="calendar-system-dropdown-container">
            <!-- Custom dropdown will be mounted here -->
          </div>
        </div>

        <div class="form__info">
          <p style="font-size: 13px; color: rgba(255, 255, 255, 0.6); margin-top: 0.5rem;">
            • <strong>Gregorian:</strong> Standard Western calendar (e.g., "30. Oct. 2024")<br>
            • <strong>Hijri:</strong> Islamic calendar (e.g., "26. Rabi' ath-Thani 1446")<br>
            • <strong>Gregorian + Hijri:</strong> Both calendars side-by-side
          </p>
        </div>

        <h3 class="subsection-title" style="margin-top: 2rem;">View Navigation</h3>
        <div class="form__info">
          <p>Configure how notes, profiles, and other views are opened in the app.</p>
        </div>

        <div class="view-tabs-switch-container" id="view-tabs-switch-container">
          <!-- Switch will be mounted here -->
        </div>

        <div class="form__info">
          <p style="font-size: 13px; color: rgba(255, 255, 255, 0.6); margin-top: 0.5rem;">
            When enabled, clicking on notes, profiles, notifications, or messages will open as tabs in the right pane instead of the main view.
          </p>
          <p style="font-size: 13px; color: rgba(255, 255, 255, 0.6);">
            • Single click: Open in new tab or switch to existing tab<br>
            • Double-click or Cmd+Click: Open additional tabs
          </p>
        </div>
      </div>
    `;
  }

  /**
   * Bind event listeners
   */
  private bindListeners(contentContainer: HTMLElement): void {
    // Calendar system dropdown
    const dropdownContainer = contentContainer.querySelector('.calendar-system-dropdown-container');
    if (dropdownContainer) {
      const calendarSystem = this.storage.get<string>(StorageKeys.CALENDAR_SYSTEM, 'gregorian');

      this.calendarDropdown = new CustomDropdown({
        options: [
          { value: 'gregorian', label: 'Gregorian' },
          { value: 'hijri', label: 'Hijri (Islamic)' },
          { value: 'both', label: 'Gregorian + Hijri' },
        ],
        selectedValue: calendarSystem,
        onChange: (value) => {
          this.storage.set(StorageKeys.CALENDAR_SYSTEM, value);

          // Emit event for immediate effect (triggers re-render of timestamps)
          this.eventBus.emit('settings:calendar-system-changed', { system: value });

          const labels = {
            gregorian: 'Gregorian calendar',
            hijri: 'Hijri (Islamic) calendar',
            both: 'Gregorian + Hijri calendars',
          };

          ToastService.show(`Switched to ${labels[value as keyof typeof labels]}`, 'success');
        },
        className: 'calendar-system-dropdown',
        width: '100%',
      });

      dropdownContainer.appendChild(this.calendarDropdown.getElement());
    }

    // Initialize View Tabs switch
    const switchContainer = contentContainer.querySelector('#view-tabs-switch-container');
    if (switchContainer) {
      const isEnabled = this.storage.get<boolean>(StorageKeys.VIEW_TABS_RIGHT_PANE, false);

      this.viewTabsSwitch = new Switch({
        label: 'Open views in right pane',
        checked: isEnabled,
        onChange: (checked) => {
          this.storage.set(StorageKeys.VIEW_TABS_RIGHT_PANE, checked);

          // Emit event for immediate effect (no reload needed)
          this.eventBus.emit('settings:view-tabs-changed', { enabled: checked });

          ToastService.show(
            checked ? 'View tabs enabled' : 'View tabs disabled',
            'success'
          );
        }
      });

      switchContainer.innerHTML = this.viewTabsSwitch.render();
      this.viewTabsSwitch.setupEventListeners(switchContainer as HTMLElement);
    }
  }

  /**
   * Unmount section and cleanup
   */
  public unmount(): void {
    if (this.calendarDropdown) {
      this.calendarDropdown.destroy();
      this.calendarDropdown = null;
    }
  }
}
