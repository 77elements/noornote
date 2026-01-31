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
import { PerAccountLocalStorage, StorageKeys, type LayoutMode } from '../../services/PerAccountLocalStorage';
import { LayoutService } from '../../services/LayoutService';
import { ToastService } from '../../services/ToastService';
import { EventBus } from '../../services/EventBus';
import { PlatformService } from '../../services/PlatformService';

export class UISettingsSection extends SettingsSection {
  private storage: PerAccountLocalStorage;
  private layoutService: LayoutService;
  private eventBus: EventBus;
  private layoutModeDropdown: CustomDropdown | null = null;
  private postTruncationSwitch: Switch | null = null;
  private calendarDropdown: CustomDropdown | null = null;
  private autoUpdateSwitch: Switch | null = null;

  constructor() {
    super('ui-settings');
    this.storage = PerAccountLocalStorage.getInstance();
    this.layoutService = LayoutService.getInstance();
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
    const isTauri = PlatformService.getInstance().isTauri;

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

        <div class="layout-mode-section">
          <h3 class="subsection-title" style="margin-top: 2rem;">Layout Mode</h3>
          <div class="form__info">
            <p>Configure how the app layout behaves when opening notes, profiles, and other views.</p>
          </div>

          <div class="form-group">
            <label class="form-label">Layout Mode</label>
            <div class="layout-mode-dropdown-container">
              <!-- Layout mode dropdown will be mounted here -->
            </div>
          </div>

          <div class="form__info">
            <p style="font-size: 13px; color: rgba(255, 255, 255, 0.6); margin-top: 0.5rem;">
              • <strong>Default:</strong> Views replace the timeline in the main pane, right pane shows System Logger<br>
              • <strong>Right Pane:</strong> Views open as tabs in the right pane, timeline stays visible in main pane<br>
              • <strong>Wide Mode:</strong> Views replace the timeline, right pane is hidden for maximum content space<br>
              • <strong>Phone:</strong> Single-column layout (390px width) for phone development and testing
            </p>
            <p style="font-size: 13px; color: rgba(255, 255, 255, 0.6);">
              <strong>Right Pane mode click behavior:</strong><br>
              • Single click: Open in new tab or switch to existing tab<br>
              • Double-click or Cmd+Click: Open additional tabs
            </p>
          </div>
        </div>

        <h3 class="subsection-title" style="margin-top: 2rem;">Content Display</h3>
        <div class="form__info">
          <p>Configure how long posts are displayed in the timeline.</p>
        </div>

        <div class="post-truncation-switch-container" id="post-truncation-switch-container">
          <!-- Switch will be mounted here -->
        </div>

        <div class="form__info">
          <p style="font-size: 13px; color: rgba(255, 255, 255, 0.6); margin-top: 0.5rem;">
            When enabled, long posts will always be displayed in full without "Show More" buttons. This may affect timeline scrolling performance for very long posts.
          </p>
        </div>

        ${isTauri ? `
          <h3 class="subsection-title" style="margin-top: 2rem;">Updates</h3>

          <div id="auto-update-switch-container">
            <!-- Switch will be mounted here -->
          </div>

          <div style="margin-top: 1rem;">
            <button class="btn btn--mini" id="check-update-now-btn">Check now</button>
          </div>
        ` : ''}
      </div>
    `;
  }

  /**
   * Bind event listeners
   */
  private bindListeners(contentContainer: HTMLElement): void {
    // Calendar system dropdown
    const calendarDropdownContainer = contentContainer.querySelector('.calendar-system-dropdown-container');
    if (calendarDropdownContainer) {
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

      calendarDropdownContainer.appendChild(this.calendarDropdown.getElement());
    }

    // Layout mode dropdown
    const layoutModeDropdownContainer = contentContainer.querySelector('.layout-mode-dropdown-container');
    if (layoutModeDropdownContainer) {
      const currentMode = this.layoutService.getCurrentMode();

      this.layoutModeDropdown = new CustomDropdown({
        options: [
          { value: 'default', label: 'Default' },
          { value: 'right-pane', label: 'Right Pane' },
          { value: 'wide', label: 'Wide Mode' },
          { value: 'phone', label: 'Phone' },
        ],
        selectedValue: currentMode,
        onChange: async (value) => {
          const mode = value as LayoutMode;
          await this.layoutService.setMode(mode);

          const labels: Record<LayoutMode, string> = {
            'default': 'Default layout mode',
            'right-pane': 'Right pane mode (views as tabs)',
            'wide': 'Wide mode (hide right pane)',
            'phone': 'Phone layout (390px width)',
          };

          ToastService.show(`Switched to ${labels[mode]}`, 'success');
        },
        className: 'layout-mode-dropdown',
        width: '100%',
      });

      layoutModeDropdownContainer.appendChild(this.layoutModeDropdown.getElement());
    }

    // Initialize Post Truncation switch
    const postTruncationContainer = contentContainer.querySelector('#post-truncation-switch-container');
    if (postTruncationContainer) {
      const isDisabled = this.storage.get<boolean>(StorageKeys.DISABLE_POST_TRUNCATION, false);

      this.postTruncationSwitch = new Switch({
        label: 'Disable post truncation',
        checked: isDisabled,
        onChange: (checked) => {
          this.storage.set(StorageKeys.DISABLE_POST_TRUNCATION, checked);

          // Emit event for immediate effect
          this.eventBus.emit('settings:post-truncation-changed', { disabled: checked });

          ToastService.show(
            checked ? 'Post truncation disabled - all posts will be shown in full' : 'Post truncation enabled',
            'success'
          );
        }
      });

      postTruncationContainer.innerHTML = this.postTruncationSwitch.render();
      this.postTruncationSwitch.setupEventListeners(postTruncationContainer as HTMLElement);
    }

    // Initialize Auto-Update switch (Tauri only)
    this.bindUpdateSettings(contentContainer);
  }

  /**
   * Bind update settings (Tauri desktop only)
   */
  private bindUpdateSettings(contentContainer: HTMLElement): void {
    const autoUpdateContainer = contentContainer.querySelector('#auto-update-switch-container');
    if (!autoUpdateContainer) return;

    import('../../services/UpdateCheckService').then(({ UpdateCheckService }) => {
      const service = UpdateCheckService.getInstance();

      this.autoUpdateSwitch = new Switch({
        label: 'Automatically check for updates',
        checked: service.isAutoCheckEnabled(),
        onChange: (checked) => {
          service.setAutoCheckEnabled(checked);
          ToastService.show(
            checked ? 'Auto-update check enabled' : 'Auto-update check disabled',
            'success'
          );
        }
      });

      autoUpdateContainer.innerHTML = this.autoUpdateSwitch.render();
      this.autoUpdateSwitch.setupEventListeners(autoUpdateContainer as HTMLElement);
    });

    const checkNowBtn = contentContainer.querySelector('#check-update-now-btn');
    checkNowBtn?.addEventListener('click', async () => {
      const { UpdateCheckService } = await import('../../services/UpdateCheckService');
      await UpdateCheckService.getInstance().checkManually(checkNowBtn as HTMLButtonElement);
    });
  }

  /**
   * Unmount section and cleanup
   */
  public unmount(): void {
    if (this.calendarDropdown) {
      this.calendarDropdown.destroy();
      this.calendarDropdown = null;
    }

    if (this.layoutModeDropdown) {
      this.layoutModeDropdown.destroy();
      this.layoutModeDropdown = null;
    }
  }
}
