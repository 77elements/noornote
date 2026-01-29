/**
 * KeySignerSection Component
 * Manages NoorSigner key signer settings (Tauri only)
 *
 * @purpose Configure autostart, silent mode, and manage key signer daemon
 * @used-by SettingsView
 */

import { SettingsSection } from './SettingsSection';
import { KeySignerClient } from '../../services/KeySignerClient';
import { AuthService } from '../../services/AuthService';
import { ToastService } from '../../services/ToastService';
import { Switch } from '../ui/Switch';

const SILENT_MODE_KEY = 'noorsigner_silent_mode';

export class KeySignerSection extends SettingsSection {
  private keySignerClient: KeySignerClient;
  private authService: AuthService;
  private autostartSwitch: Switch | null = null;
  private silentModeSwitch: Switch | null = null;

  constructor(keySignerClient: KeySignerClient) {
    super('key-signer');
    this.keySignerClient = keySignerClient;
    this.authService = AuthService.getInstance();
  }

  /**
   * Mount section content into the DOM
   */
  public async mount(parentContainer: HTMLElement): Promise<void> {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    const isRunning = await this.keySignerClient.isRunning();

    contentContainer.innerHTML = this.renderContent(isRunning);
    this.bindListeners(contentContainer);
  }

  /**
   * Render key signer settings content
   */
  private renderContent(isRunning: boolean): string {
    return `
      <div class="key-signer-settings">
        <div class="key-signer-status">
          <div class="status-indicator ${isRunning ? 'status-running' : 'status-stopped'}">
            <span class="status-dot"></span>
            <span class="status-text">${isRunning ? 'Key Signer Running' : 'Key Signer Stopped'}</span>
          </div>
        </div>

        ${isRunning ? `
          <div class="key-signer-autostart">
            <div class="setting-row">
              <div class="setting-info">
                <label class="setting-label">Launch key signer on system startup</label>
                <p class="setting-description">Automatically start NoorSigner key signer when you log in to your computer.</p>
              </div>
              <div id="autostart-switch-container"></div>
            </div>
          </div>

          <div class="key-signer-autostart">
            <div class="setting-row">
              <div class="setting-info">
                <label class="setting-label">Manage NoorSigner via NoorNote</label>
                <p class="setting-description">Handle password prompts through NoorNote instead of opening a terminal window.</p>
              </div>
              <div id="silent-mode-switch-container"></div>
            </div>
          </div>

          <div class="settings-section__actions">
            <button class="btn btn--medium" id="stop-daemon-btn">Stop Key Signer & Logout</button>
          </div>
        ` : `
          <div class="key-signer-info">
            <p>NoorSigner key signer is not running. Start it by logging in with NoorSigner.</p>
          </div>
        `}
      </div>
    `;
  }

  /**
   * Bind event listeners
   */
  private async bindListeners(contentContainer: HTMLElement): Promise<void> {
    const isRunning = await this.keySignerClient.isRunning();

    if (isRunning) {
      const isEnabled = await this.keySignerClient.getAutostartStatus();

      // Autostart switch
      const switchContainer = contentContainer.querySelector('#autostart-switch-container');
      if (switchContainer) {
        this.autostartSwitch = new Switch({
          label: '',
          checked: isEnabled,
          onChange: async (checked) => {
            try {
              if (checked) {
                await this.keySignerClient.enableAutostart();
                ToastService.show('Autostart enabled', 'success');
              } else {
                await this.keySignerClient.disableAutostart();
                ToastService.show('Autostart disabled', 'success');
              }
            } catch (error) {
              console.error('Failed to toggle autostart:', error);
              ToastService.show('Failed to toggle autostart', 'error');

              // Refresh section to reflect actual state
              const parentContainer = contentContainer.closest('.settings-container') as HTMLElement;
              if (parentContainer) {
                this.mount(parentContainer);
              }
            }
          }
        });

        switchContainer.innerHTML = this.autostartSwitch.render();
        this.autostartSwitch.setupEventListeners(switchContainer as HTMLElement);
      }

      // Silent mode switch
      const silentContainer = contentContainer.querySelector('#silent-mode-switch-container');
      if (silentContainer) {
        const isSilent = localStorage.getItem(SILENT_MODE_KEY) === 'true';

        this.silentModeSwitch = new Switch({
          label: '',
          checked: isSilent,
          onChange: (checked) => {
            localStorage.setItem(SILENT_MODE_KEY, String(checked));
            ToastService.show(
              checked ? 'NoorSigner managed via NoorNote' : 'NoorSigner uses terminal mode',
              'success'
            );
          }
        });

        silentContainer.innerHTML = this.silentModeSwitch.render();
        this.silentModeSwitch.setupEventListeners(silentContainer as HTMLElement);
      }

      const stopBtn = contentContainer.querySelector('#stop-daemon-btn');
      if (stopBtn) {
        stopBtn.addEventListener('click', async () => {
          await this.authService.signOut();
        });
      }
    }
  }

  /**
   * Unmount section and cleanup
   */
  public unmount(): void {
    this.autostartSwitch = null;
    this.silentModeSwitch = null;
  }
}
