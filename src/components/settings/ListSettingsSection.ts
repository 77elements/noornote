/**
 * ListSettingsSection Component
 * Manages list synchronization mode (Manual vs Easy Mode)
 * Includes Danger Zone for resetting corrupted list data
 *
 * @purpose Configure automatic list sync behavior + reset options
 * @used-by SettingsView
 */

import { SettingsSection } from './SettingsSection';
import { ToastService } from '../../services/ToastService';
import { ModalService } from '../../services/ModalService';
import { StorageKeys } from '../../services/PerAccountLocalStorage';
import {
  getListSyncMode,
  setListSyncMode,
  type ListSyncMode
} from '../../helpers/ListSyncMode';

export class ListSettingsSection extends SettingsSection {
  private currentMode: ListSyncMode;
  private modalService: ModalService;

  constructor() {
    super('list-settings');
    this.currentMode = getListSyncMode();
    this.modalService = ModalService.getInstance();
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

        <!-- Danger Zone -->
        <div class="danger-zone">
          <h3 class="subsection-title">Danger Zone</h3>

          <div class="danger-zone__warning">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
              <line x1="12" y1="9" x2="12" y2="13"></line>
              <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
            <p>These actions are irreversible and will result in data loss. Only use if you have corrupted data that prevents normal operation.</p>
          </div>

          <div class="danger-zone__actions">
            <div class="danger-zone__action">
              <div class="danger-zone__action-info">
                <h4>Reset Tribes</h4>
                <p>Delete all tribe data (folders and members). Use if tribe tabs are broken or you can't delete a tribe.</p>
              </div>
              <button class="btn btn--danger" data-action="reset-tribes">Reset Tribes</button>
            </div>

            <div class="danger-zone__action">
              <div class="danger-zone__action-info">
                <h4>Reset Bookmarks</h4>
                <p>Delete all bookmark data (items and folders).</p>
              </div>
              <button class="btn btn--danger" data-action="reset-bookmarks">Reset Bookmarks</button>
            </div>

            <div class="danger-zone__action">
              <div class="danger-zone__action-info">
                <h4>Reset Mutes</h4>
                <p>Delete your mute list (muted users and threads).</p>
              </div>
              <button class="btn btn--danger" data-action="reset-mutes">Reset Mutes</button>
            </div>

            <div class="danger-zone__action">
              <div class="danger-zone__action-info">
                <h4>Reset Follows</h4>
                <p>Delete your follow list. <strong>Make a backup first!</strong></p>
              </div>
              <button class="btn btn--danger" data-action="reset-follows">Reset Follows</button>
            </div>
          </div>
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

    // Danger Zone buttons
    contentContainer.querySelector('[data-action="reset-tribes"]')
      ?.addEventListener('click', () => this.confirmResetTribes());

    contentContainer.querySelector('[data-action="reset-bookmarks"]')
      ?.addEventListener('click', () => this.confirmResetBookmarks());

    contentContainer.querySelector('[data-action="reset-mutes"]')
      ?.addEventListener('click', () => this.confirmResetMutes());

    contentContainer.querySelector('[data-action="reset-follows"]')
      ?.addEventListener('click', () => this.confirmResetFollows());
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

  // ========================================
  // Danger Zone Methods
  // ========================================

  /**
   * Show confirmation modal for Tribes reset
   */
  private confirmResetTribes(): void {
    this.showResetModal({
      title: 'Reset Tribes?',
      listName: 'tribes',
      warningHtml: `
        <p>This will delete <strong>all your tribe data</strong> including:</p>
        <ul>
          <li>All tribe folders</li>
          <li>All tribe members</li>
          <li>Tribe timeline tabs</li>
        </ul>
      `,
      onConfirm: () => this.resetTribes()
    });
  }

  /**
   * Show confirmation modal for Bookmarks reset
   */
  private confirmResetBookmarks(): void {
    this.showResetModal({
      title: 'Reset Bookmarks?',
      listName: 'bookmarks',
      warningHtml: `
        <p>This will delete <strong>all your bookmark data</strong> including:</p>
        <ul>
          <li>All bookmarked notes</li>
          <li>All custom bookmarks (URLs)</li>
          <li>All bookmark folders</li>
        </ul>
      `,
      onConfirm: () => this.resetBookmarks()
    });
  }

  /**
   * Show confirmation modal for Mutes reset
   */
  private confirmResetMutes(): void {
    this.showResetModal({
      title: 'Reset Mutes?',
      listName: 'mutes',
      warningHtml: `
        <p>This will delete <strong>your entire mute list</strong> including:</p>
        <ul>
          <li>All muted users</li>
          <li>All muted threads</li>
        </ul>
        <p style="margin-top: 0.5rem;">Muted users will appear in your timeline again.</p>
      `,
      onConfirm: () => this.resetMutes()
    });
  }

  /**
   * Show confirmation modal for Follows reset (with extra warnings)
   */
  private confirmResetFollows(): void {
    this.modalService.show({
      title: 'Reset Follows? (Critical)',
      content: `
        <div class="danger-zone-modal">
          <div class="danger-zone-modal__warning danger-zone-modal__warning--critical">
            <strong>Your follow list is critical!</strong> This determines who appears in your timeline.
          </div>

          <p style="margin: 1rem 0;"><strong>Before you continue, make a backup:</strong></p>
          <ol style="margin: 0 0 1rem 1.5rem; line-height: 1.6;">
            <li>Visit <a href="https://follows.nostr.com/" target="_blank">follows.nostr.com</a> in your browser</li>
            <li>This automatically saves your contacts</li>
            <li>Then come back and reset</li>
          </ol>

          <p style="margin-bottom: 1rem;">This will delete <strong>all your follows</strong> from local storage.</p>

          <div class="danger-zone-modal__recovery">
            <strong>Recovery options:</strong>
            <ul style="margin: 0.5rem 0 0 1.5rem;">
              <li>If you synced to relays before: Go to List Settings → Manual Mode → "Sync from relays"</li>
              <li>If you used follows.nostr.com: Visit the site again to restore</li>
              <li>Otherwise: <strong>Data is lost forever</strong></li>
            </ul>
          </div>

          <div style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1.5rem;">
            <button class="btn" data-action="cancel">Cancel</button>
            <button class="btn btn--danger" data-action="confirm">I Made a Backup, Reset Follows</button>
          </div>
        </div>
      `,
      width: '500px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true
    });

    this.bindModalActions(() => this.resetFollows());
  }

  /**
   * Generic reset modal for lists (Tribes, Bookmarks, Mutes)
   */
  private showResetModal(options: {
    title: string;
    listName: string;
    warningHtml: string;
    onConfirm: () => void;
  }): void {
    this.modalService.show({
      title: options.title,
      content: `
        <div class="danger-zone-modal">
          ${options.warningHtml}

          <div class="danger-zone-modal__recovery">
            <strong>Recovery options:</strong>
            <ul style="margin: 0.5rem 0 0 1.5rem;">
              <li>If you synced your ${options.listName} to relays before: Go to List Settings → Switch to Manual Mode → "Sync from relays"</li>
              <li>Otherwise: <strong>Data is lost forever</strong></li>
            </ul>
          </div>

          <div class="danger-zone-modal__warning">
            This action cannot be undone.
          </div>

          <div style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1.5rem;">
            <button class="btn" data-action="cancel">Cancel</button>
            <button class="btn btn--danger" data-action="confirm">Reset ${options.listName.charAt(0).toUpperCase() + options.listName.slice(1)}</button>
          </div>
        </div>
      `,
      width: '500px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true
    });

    this.bindModalActions(options.onConfirm);
  }

  /**
   * Bind modal action buttons
   */
  private bindModalActions(onConfirm: () => void): void {
    setTimeout(() => {
      document.querySelector('[data-action="cancel"]')
        ?.addEventListener('click', () => this.modalService.hide());

      document.querySelector('[data-action="confirm"]')
        ?.addEventListener('click', () => {
          this.modalService.hide();
          onConfirm();
        });
    }, 0);
  }

  /**
   * Reset Tribes data
   */
  private resetTribes(): void {
    localStorage.removeItem(StorageKeys.TRIBES);
    localStorage.removeItem(StorageKeys.TRIBE_FOLDERS);
    localStorage.removeItem(StorageKeys.TRIBE_MEMBER_ASSIGNMENTS);
    localStorage.removeItem(StorageKeys.TRIBE_ROOT_ORDER);

    ToastService.show('Tribes reset. Reloading...', 'success');
    setTimeout(() => window.location.reload(), 1000);
  }

  /**
   * Reset Bookmarks data
   */
  private resetBookmarks(): void {
    localStorage.removeItem(StorageKeys.BOOKMARKS);
    localStorage.removeItem(StorageKeys.BOOKMARK_FOLDERS);
    localStorage.removeItem(StorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS);
    localStorage.removeItem(StorageKeys.BOOKMARK_ROOT_ORDER);

    ToastService.show('Bookmarks reset. Reloading...', 'success');
    setTimeout(() => window.location.reload(), 1000);
  }

  /**
   * Reset Mutes data
   */
  private resetMutes(): void {
    localStorage.removeItem(StorageKeys.MUTES);

    ToastService.show('Mutes reset. Reloading...', 'success');
    setTimeout(() => window.location.reload(), 1000);
  }

  /**
   * Reset Follows data
   */
  private resetFollows(): void {
    localStorage.removeItem(StorageKeys.FOLLOWS);

    ToastService.show('Follows reset. Reloading...', 'success');
    setTimeout(() => window.location.reload(), 1000);
  }

  /**
   * Unmount section and cleanup
   */
  public unmount(): void {
    // Cleanup if needed
  }
}
