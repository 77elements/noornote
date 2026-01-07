/**
 * ListSettingsSection Component
 * Manages list synchronization mode (Manual vs Easy Mode)
 *
 * @purpose Configure automatic list sync behavior
 * @used-by SettingsView
 */

import { SettingsSection } from './SettingsSection';
import { ToastService } from '../../services/ToastService';
import {
  getListSyncMode,
  setListSyncMode,
  type ListSyncMode
} from '../../helpers/ListSyncMode';

export class ListSettingsSection extends SettingsSection {
  private currentMode: ListSyncMode;

  constructor() {
    super('list-settings');
    this.currentMode = getListSyncMode();
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
   * Render list settings content
   */
  private renderContent(): string {
    return `
      <div class="list-settings">
        <div class="form__info">
          <p>Choose how NoorNote syncs your lists (Follows, Bookmarks, Mutes) across your local backup and relays.</p>
        </div>

        <div class="list-settings__mode-selector">
          <h3 class="subsection-title">Synchronisation Mode</h3>

          <div class="mode-options">
            <label class="mode-option ${this.currentMode === 'manual' ? 'mode-option--active' : ''}">
              <input
                type="radio"
                name="list-sync-mode"
                value="manual"
                ${this.currentMode === 'manual' ? 'checked' : ''}
              />
              <div class="mode-option__content">
                <div class="mode-option__title">Manual Mode</div>
                <div class="mode-option__description">
                  Manage sync manually with action buttons in each list. You decide when to sync from relays, publish to relays, or save backups.
                </div>
              </div>
            </label>

            <label class="mode-option ${this.currentMode === 'easy' ? 'mode-option--active' : ''}">
              <input
                type="radio"
                name="list-sync-mode"
                value="easy"
                ${this.currentMode === 'easy' ? 'checked' : ''}
              />
              <div class="mode-option__content">
                <div class="mode-option__title">Easy Mode</div>
                <div class="mode-option__description">
                  NoorNote syncs automatically:
                  <ul class="mode-option__features">
                    <li>Changes saved to local backup immediately</li>
                    <li>Then published to relays automatically</li>
                    <li>On startup: restore from backup or relays if needed</li>
                  </ul>
                </div>
              </div>
            </label>
          </div>
        </div>

        <div class="settings-section__actions">
          <button class="btn btn--medium" id="save-list-settings-btn">Save Settings</button>
          <div class="settings-section__action-feedback" id="list-settings-message"></div>
        </div>
      </div>
    `;
  }

  /**
   * Bind event listeners
   */
  private bindListeners(contentContainer: HTMLElement): void {
    // Mode radio buttons
    const radioButtons = contentContainer.querySelectorAll('input[name="list-sync-mode"]');
    radioButtons.forEach(radio => {
      radio.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        this.currentMode = target.value as ListSyncMode;

        // Update active state on labels
        const labels = contentContainer.querySelectorAll('.mode-option');
        labels.forEach(label => {
          const input = label.querySelector('input') as HTMLInputElement;
          if (input.checked) {
            label.classList.add('mode-option--active');
          } else {
            label.classList.remove('mode-option--active');
          }
        });
      });
    });

    // Save button
    const saveBtn = contentContainer.querySelector('#save-list-settings-btn');
    saveBtn?.addEventListener('click', () => this.handleSave(contentContainer));
  }

  /**
   * Handle save settings
   */
  private handleSave(contentContainer: HTMLElement): void {
    const previousMode = getListSyncMode();
    setListSyncMode(this.currentMode);

    const modeLabel = this.currentMode === 'easy' ? 'Easy Mode' : 'Manual Mode';

    if (previousMode !== this.currentMode) {
      this.showMessage(contentContainer, `Switched to ${modeLabel}`, 'success');
      ToastService.show(`List sync: ${modeLabel} enabled`, 'success');
    } else {
      this.showMessage(contentContainer, 'Settings saved', 'success');
    }
  }

  /**
   * Show feedback message
   */
  private showMessage(
    contentContainer: HTMLElement,
    message: string,
    type: 'success' | 'error'
  ): void {
    const messageEl = contentContainer.querySelector('#list-settings-message');
    if (!messageEl) return;

    messageEl.textContent = message;
    messageEl.className = `settings-section__action-feedback settings-section__action-feedback--${type}`;

    setTimeout(() => {
      messageEl.textContent = '';
      messageEl.className = 'settings-section__action-feedback';
    }, 5000);
  }

  /**
   * Unmount section and cleanup
   */
  public unmount(): void {
    // Cleanup if needed
  }
}
