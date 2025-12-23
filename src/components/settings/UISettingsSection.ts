/**
 * UISettingsSection Component
 * Manages UI-related settings (experimental view navigation features)
 *
 * @purpose Configure UI behavior and experimental features
 * @used-by SettingsView
 */

import { SettingsSection } from './SettingsSection';
import { Switch } from '../ui/Switch';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
import { ToastService } from '../../services/ToastService';
import { EventBus } from '../../services/EventBus';

export class UISettingsSection extends SettingsSection {
  private storage: PerAccountLocalStorage;
  private eventBus: EventBus;
  private viewTabsSwitch: Switch | null = null;

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
        <h3 class="subsection-title">View Navigation</h3>
        <div class="form__info">
          <p>Configure how notes, profiles, and other views are opened in the app.</p>
        </div>

        <div class="view-tabs-switch-container" id="view-tabs-switch-container">
          <!-- Switch will be mounted here -->
        </div>

        <div class="form__info">
          <p style="font-size: 13px; color: rgba(255, 255, 255, 0.6); margin-top: 0.5rem;">
            When enabled, clicking on notes, profiles, notifications, or messages will open them as tabs in the right sidebar instead of the main view.
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
    // Cleanup if needed
  }
}
