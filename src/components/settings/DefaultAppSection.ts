/**
 * DefaultAppSection Component
 * Allows users to set Noornote as the default handler for nostr: links
 *
 * @purpose Check/set default URL scheme handler for nostr:
 * @used-by SettingsView (Tauri desktop only)
 */

import { SettingsSection } from './SettingsSection';
import { ToastService } from '../../services/ToastService';

export class DefaultAppSection extends SettingsSection {
  constructor() {
    super('default-app-settings');
  }

  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    contentContainer.innerHTML = `
      <div class="settings-group">
        <p class="default-app-status">Checking...</p>
        <button class="btn set-default-btn" style="display: none;">
          Set as Default Nostr App
        </button>
      </div>
    `;

    this.checkStatus(contentContainer);
  }

  private async checkStatus(container: HTMLElement): Promise<void> {
    const statusEl = container.querySelector('.default-app-status');
    const btnEl = container.querySelector('.set-default-btn') as HTMLButtonElement | null;
    if (!statusEl || !btnEl) return;

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const isDefault = await invoke<boolean>('is_default_nostr_handler');

      if (isDefault) {
        statusEl.textContent = 'Noornote is your default Nostr app.';
        btnEl.style.display = 'none';
      } else {
        statusEl.textContent = 'Noornote is not your default Nostr app. Other apps will open nostr: links instead.';
        btnEl.style.display = '';
        btnEl.onclick = () => this.setDefault(container);
      }
    } catch {
      statusEl.textContent = 'Could not determine default Nostr app status.';
    }
  }

  private async setDefault(container: HTMLElement): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_default_nostr_handler');
      ToastService.show('Noornote is now your default Nostr app', 'success');
      this.checkStatus(container);
    } catch (error) {
      ToastService.show('Failed to set default handler', 'error');
    }
  }

  public unmount(): void {
    // No cleanup needed
  }
}
