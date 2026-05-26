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
import { ThemeSwitcher } from '../ui/ThemeSwitcher';
import { FontSizeSwitcher } from '../ui/FontSizeSwitcher';
import { PerAccountLocalStorage, StorageKeys, type LayoutMode } from '../../services/PerAccountLocalStorage';
import { LayoutService } from '../../services/LayoutService';
import { ToastService } from '../../services/ToastService';
import { EventBus } from '../../services/EventBus';
import { PlatformService } from '../../services/PlatformService';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { SettingsModuleApi } from '../../modules/settings/contracts';

export class UISettingsSection extends SettingsSection {
  private storage: PerAccountLocalStorage;
  private layoutService: LayoutService;
  private eventBus: EventBus;
  private layoutModeDropdown: CustomDropdown | null = null;
  private postTruncationSwitch: Switch | null = null;
  private contentVisibilitySwitch: Switch | null = null;
  private clientTagSwitch: Switch | null = null;
  private calendarDropdown: CustomDropdown | null = null;
  private autoUpdateSwitch: Switch | null = null;
  private themeSwitcher: ThemeSwitcher | null = null;
  private fontSizeSwitcher: FontSizeSwitcher | null = null;

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
    const platform = PlatformService.getInstance();
    const isDesktop = platform.isDesktop;

    return `
        <section class="section">
          <div class="setting">
            <span class="setting__label">Theme</span>
            <div class="setting__control" id="theme-switcher-mount"></div>
          </div>
        </section>

        <section class="section">
          <div class="setting">
            <span class="setting__label">Font Size</span>
            <div class="setting__control" id="font-size-switcher-mount"></div>
          </div>
        </section>

        <section class="section">
          <div class="setting">
            <span class="setting__label">Layout Mode</span>
            <div class="setting__control layout-mode-dropdown-container"></div>
            <ul class="setting__desc">
              <li><strong>Default:</strong> Views replace the timeline in the main pane, right pane shows System Logger</li>
              <li><strong>Right Pane:</strong> Views open as tabs in the right pane, timeline stays visible in main pane</li>
              <li><strong>Wide Mode:</strong> Views replace the timeline, right pane is hidden for maximum content space</li>
              <li><strong>Phone:</strong> Single-column layout (390px width) for phone development and testing</li>
            </ul>
          </div>
        </section>

        <section class="section">
          <div class="setting">
            <span class="setting__label">Date Format</span>
            <div class="setting__control calendar-system-dropdown-container"></div>
            <ul class="setting__desc">
              <li><strong>Gregorian:</strong> Standard Western calendar (e.g., "30. Oct. 2024")</li>
              <li><strong>Hijri:</strong> Islamic calendar (e.g., "26. Rabi' ath-Thani 1446")</li>
              <li><strong>Gregorian + Hijri:</strong> Both calendars side-by-side</li>
            </ul>
          </div>
        </section>

        <section class="section">
          <div class="setting">
            <span class="setting__label">Disable post truncation</span>
            <div class="setting__control" id="post-truncation-switch-container"></div>
            <p class="setting__desc">
              When enabled, long posts will always be displayed in full without "Show More" buttons.
            </p>
          </div>
        </section>

        <section class="section">
          <div class="setting">
            <span class="setting__label">Memory optimization (experimental)</span>
            <div class="setting__control" id="content-visibility-switch-container"></div>
            <p class="setting__desc">
              Skips rendering of off-screen notes (CSS <code>content-visibility: auto</code>).
              Significantly reduces memory usage on long timelines, especially on Linux.
              May cause minor scrollbar jumps when scrolling fast — disable if it bothers you.
            </p>
          </div>
        </section>

        <section class="section">
          <div class="setting">
            <span class="setting__label">Sign posts with "via NoorNote"</span>
            <div class="setting__control" id="client-tag-switch-container"></div>
            <p class="setting__desc">
              When enabled, every event you publish carries a <code>client</code> tag identifying NoorNote. Other Nostr clients display this as "via NoorNote" next to your posts.
            </p>
          </div>
        </section>

        ${isDesktop ? `
        <section class="section">
          <div class="setting">
            <span class="setting__label">Automatically check for updates</span>
            <div class="setting__control" id="auto-update-switch-container"></div>
          </div>
          <div class="l-row l-row--center">
            <button class="btn btn--mini" id="check-update-now-btn">Check now</button>
          </div>
        </section>
        ` : ''}
    `;
  }

  /**
   * Bind event listeners
   */
  private bindListeners(contentContainer: HTMLElement): void {
    // Theme switcher
    const themeMount = contentContainer.querySelector('#theme-switcher-mount');
    if (themeMount) {
      this.themeSwitcher = new ThemeSwitcher();
      themeMount.appendChild(this.themeSwitcher.getElement());
    }

    // Font size switcher
    const fontSizeMount = contentContainer.querySelector('#font-size-switcher-mount');
    if (fontSizeMount) {
      this.fontSizeSwitcher = new FontSizeSwitcher();
      fontSizeMount.appendChild(this.fontSizeSwitcher.getElement());
    }

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
      });

      layoutModeDropdownContainer.appendChild(this.layoutModeDropdown.getElement());
    }

    // Initialize Post Truncation switch
    const postTruncationContainer = contentContainer.querySelector('#post-truncation-switch-container');
    if (postTruncationContainer) {
      const isDisabled = this.storage.get<boolean>(StorageKeys.DISABLE_POST_TRUNCATION, false);

      this.postTruncationSwitch = new Switch({
        label: '',
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

    // Initialize Content Visibility switch
    const contentVisibilityContainer = contentContainer.querySelector('#content-visibility-switch-container');
    if (contentVisibilityContainer) {
      const enabled = this.storage.get<boolean>(StorageKeys.CONTENT_VISIBILITY_AUTO, false);

      this.contentVisibilitySwitch = new Switch({
        label: '',
        checked: enabled,
        onChange: (checked) => {
          this.storage.set(StorageKeys.CONTENT_VISIBILITY_AUTO, checked);
          document.documentElement.classList.toggle('content-visibility-auto', checked);
          ToastService.show(
            checked ? 'Memory optimization enabled' : 'Memory optimization disabled',
            'success'
          );
        }
      });

      contentVisibilityContainer.innerHTML = this.contentVisibilitySwitch.render();
      this.contentVisibilitySwitch.setupEventListeners(contentVisibilityContainer as HTMLElement);
    }

    // Initialize Client Tag switch
    const clientTagContainer = contentContainer.querySelector('#client-tag-switch-container');
    if (clientTagContainer) {
      import('../../helpers/clientTagSetting').then(({ isClientTagEnabled, setClientTagEnabled }) => {
        this.clientTagSwitch = new Switch({
          label: '',
          checked: isClientTagEnabled(),
          onChange: (checked) => {
            setClientTagEnabled(checked);
            ToastService.show(
              checked ? 'Posts will be signed with "via NoorNote"' : 'Posts will be signed without client tag',
              'success'
            );
          }
        });
        clientTagContainer.innerHTML = this.clientTagSwitch.render();
        this.clientTagSwitch.setupEventListeners(clientTagContainer as HTMLElement);
      });
    }

    // Initialize Auto-Update switch (Desktop only)
    this.bindUpdateSettings(contentContainer);
  }

  /**
   * Bind update settings (Desktop only)
   */
  private bindUpdateSettings(contentContainer: HTMLElement): void {
    const autoUpdateContainer = contentContainer.querySelector('#auto-update-switch-container');
    if (!autoUpdateContainer) return;

    const settingsApi = ModuleLoader.getInstance().getApi<SettingsModuleApi>('settings');
    if (settingsApi) {
      this.autoUpdateSwitch = new Switch({
        label: '',
        checked: settingsApi.isAutoCheckEnabled(),
        onChange: (checked) => {
          settingsApi.setAutoCheckEnabled(checked);
          ToastService.show(
            checked ? 'Auto-update check enabled' : 'Auto-update check disabled',
            'success'
          );
        }
      });

      autoUpdateContainer.innerHTML = this.autoUpdateSwitch.render();
      this.autoUpdateSwitch.setupEventListeners(autoUpdateContainer as HTMLElement);
    }

    const checkNowBtn = contentContainer.querySelector('#check-update-now-btn');
    checkNowBtn?.addEventListener('click', async () => {
      const api = ModuleLoader.getInstance().getApi<SettingsModuleApi>('settings');
      await api?.checkUpdateManually(checkNowBtn as HTMLButtonElement);
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

    if (this.themeSwitcher) {
      this.themeSwitcher.destroy();
      this.themeSwitcher = null;
    }

    if (this.fontSizeSwitcher) {
      this.fontSizeSwitcher.destroy();
      this.fontSizeSwitcher = null;
    }
  }
}
