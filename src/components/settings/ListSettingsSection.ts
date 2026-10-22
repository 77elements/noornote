/**
 * ListSettingsSection Component
 * Manages list synchronization mode (Manual vs Easy Mode)
 * Includes Danger Zone for resetting corrupted list data
 *
 * @purpose Configure automatic list sync behavior + reset options
 * @used-by SettingsView
 */

import { SettingsSection } from './SettingsSection';
import { Switch } from '../ui/Switch';
import { ToastService } from '../../services/ToastService';
import { ModalService } from '../../services/ModalService';
import { TypedEventBus } from '../../core/TypedEventBus';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';
import {
  isListSettingsEnabled,
  setListSettingsEnabled,
} from '../../addons/list-settings/index';
import {
  getListSyncMode,
  setListSyncMode,
  type ListSyncMode,
} from '../../helpers/ListSyncMode';
import { _ } from '../../i18n';

export class ListSettingsSection extends SettingsSection {
  private currentMode: ListSyncMode;
  private modalService: ModalService;
  private enableSwitch: Switch | null = null;
  private modeChangedSubscriptionId: string | null = null;

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

    const contentZone = parentContainer.querySelector(
      '[data-addon-content="list-settings"]'
    ) as HTMLElement | null;

    const enabled = isListSettingsEnabled();

    // Switch toggle
    this.enableSwitch = new Switch({
      label: '',
      checked: enabled,
      onChange: checked => {
        setListSettingsEnabled(checked);
        if (!checked) {
          // Force Easy Mode when disabling
          this.currentMode = 'easy';
          setListSyncMode('easy');
        }
        if (contentZone) this.renderAdvancedContent(contentZone, checked);
        const label = checked
          ? _('Advanced List Management enabled')
          : _('Advanced List Management disabled (Easy Mode)');
        ToastService.show(label, 'success');
      },
    });

    contentContainer.innerHTML = `
      <div class="setting">
        <span class="setting__label">${_('Enable Advanced List Management')}</span>
        <div class="setting__control">${this.enableSwitch.render()}</div>
        <p class="setting__desc">${_('Switch between Easy Mode (automatic sync) and Manual Mode (action buttons in every list to control sync from/to relays and local backups). Also unlocks the Danger Zone for resetting corrupted list data.')}</p>
      </div>
    `;
    this.enableSwitch.setupEventListeners(contentContainer);
    if (contentZone) this.renderAdvancedContent(contentZone, enabled);

    // Sync when mode changes externally (e.g. "Switch to manual mode" link in list views)
    this.modeChangedSubscriptionId = TypedEventBus.getInstance().on(
      'list-sync-mode:changed',
      ({ mode }: { mode: string }) => {
        this.currentMode = mode as ListSyncMode;

        if (mode === 'manual' && !isListSettingsEnabled()) {
          // Switching to manual: enable advanced list management
          setListSettingsEnabled(true);
          this.enableSwitch?.setChecked(true);
        } else if (mode === 'easy' && isListSettingsEnabled()) {
          // Switching to easy: disable advanced list management
          setListSettingsEnabled(false);
          this.enableSwitch?.setChecked(false);
        }

        if (contentZone)
          this.renderAdvancedContent(contentZone, isListSettingsEnabled());
      }
    );
  }

  /**
   * Render or clear the advanced content (mode selector + danger zone)
   */
  private renderAdvancedContent(
    contentContainer: HTMLElement,
    enabled: boolean
  ): void {
    // Remove existing advanced content
    const existing = contentContainer.querySelector('.list-settings__advanced');
    if (existing) existing.remove();

    if (!enabled) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'list-settings__advanced';
    wrapper.innerHTML = this.renderContent();
    contentContainer.appendChild(wrapper);
    this.bindListeners(wrapper);
  }

  /**
   * Render list settings content (mode selector + danger zone)
   */
  private renderContent(): string {
    return `
        <div class="list-settings__mode-selector">
          <h4 class="subsection-title">${_('Synchronisation Mode')}</h4>

          <div class="mode-options">
            <label class="nn-checkbox nn-checkbox--label-left nn-checkbox--with-desc">
              <span class="setting__label">${_('Manual Mode')}</span>
              <input type="radio" name="list-sync-mode" value="manual" ${this.currentMode === 'manual' ? 'checked' : ''} />
              <p class="nn-checkbox__desc">${_('Manage sync manually with action buttons in each list. You decide when to sync from relays, publish to relays, or save backups.')}</p>
            </label>

            <label class="nn-checkbox nn-checkbox--label-left nn-checkbox--with-desc">
              <span class="setting__label">${_('Easy Mode')}</span>
              <input type="radio" name="list-sync-mode" value="easy" ${this.currentMode === 'easy' ? 'checked' : ''} />
              <p class="nn-checkbox__desc">${_('NoorNote syncs automatically: changes are saved to a local backup immediately, then published to relays. On startup it restores from backup or relays if needed.')}</p>
            </label>
          </div>
        </div>

        <!-- Danger Zone -->
        <div class="danger-zone">
          <h4 class="subsection-title">${_('Danger Zone')}</h4>

          <div class="danger-zone__warning">
            <svg width="20" height="20"><use href="#icon-warning"/></svg>
            <p>${_('These actions are irreversible and will result in data loss. Only use if you have corrupted data that prevents normal operation.')}</p>
          </div>

          <div class="danger-zone__actions">
            <div class="danger-zone__action">
              <div class="danger-zone__action-info">
                <h4>${_('Reset Tribes')}</h4>
                <p>${_("Delete all tribe data (folders and members). Use if tribe tabs are broken or you can't delete a tribe.")}</p>
              </div>
              <button class="btn btn--danger" data-action="reset-tribes">${_('Reset Tribes')}</button>
            </div>

            <div class="danger-zone__action">
              <div class="danger-zone__action-info">
                <h4>${_('Reset Bookmarks')}</h4>
                <p>${_('Delete all bookmark data (items and folders).')}</p>
              </div>
              <button class="btn btn--danger" data-action="reset-bookmarks">${_('Reset Bookmarks')}</button>
            </div>

            <div class="danger-zone__action">
              <div class="danger-zone__action-info">
                <h4>${_('Reset Mutes')}</h4>
                <p>${_('Delete your mute list (muted users and threads).')}</p>
              </div>
              <button class="btn btn--danger" data-action="reset-mutes">${_('Reset Mutes')}</button>
            </div>

            <div class="danger-zone__action">
              <div class="danger-zone__action-info">
                <h4>${_('Reset Follows')}</h4>
                <p>${_('Delete your follow list. <strong>Make a backup first!</strong>')}</p>
              </div>
              <button class="btn btn--danger" data-action="reset-follows">${_('Reset Follows')}</button>
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
    const radioButtons = contentContainer.querySelectorAll(
      'input[name="list-sync-mode"]'
    );
    radioButtons.forEach(radio => {
      radio.addEventListener('change', e => {
        const target = e.target as HTMLInputElement;
        this.currentMode = target.value as ListSyncMode;

        setListSyncMode(this.currentMode);
        const modeLabel =
          this.currentMode === 'easy' ? _('Easy Mode') : _('Manual Mode');
        ToastService.show(_('List sync: %s enabled', modeLabel), 'success');
      });
    });

    // Danger Zone buttons
    contentContainer
      .querySelector('[data-action="reset-tribes"]')
      ?.addEventListener('click', () => this.confirmResetTribes());

    contentContainer
      .querySelector('[data-action="reset-bookmarks"]')
      ?.addEventListener('click', () => this.confirmResetBookmarks());

    contentContainer
      .querySelector('[data-action="reset-mutes"]')
      ?.addEventListener('click', () => this.confirmResetMutes());

    contentContainer
      .querySelector('[data-action="reset-follows"]')
      ?.addEventListener('click', () => this.confirmResetFollows());
  }

  // ========================================
  // Danger Zone Methods
  // ========================================

  /**
   * Show confirmation modal for Tribes reset
   */
  private confirmResetTribes(): void {
    this.showResetModal({
      title: _('Reset Tribes?'),
      listName: _('tribes'),
      warningHtml: `
        <p>${_('This will delete <strong>all your tribe data</strong> including:')}</p>
        <ul>
          <li>${_('All tribe folders')}</li>
          <li>${_('All tribe members')}</li>
          <li>${_('Tribe timeline tabs')}</li>
        </ul>
      `,
      onConfirm: () => this.resetTribes(),
    });
  }

  /**
   * Show confirmation modal for Bookmarks reset
   */
  private confirmResetBookmarks(): void {
    this.showResetModal({
      title: _('Reset Bookmarks?'),
      listName: _('bookmarks'),
      warningHtml: `
        <p>${_('This will delete <strong>all your bookmark data</strong> including:')}</p>
        <ul>
          <li>${_('All bookmarked notes')}</li>
          <li>${_('All custom bookmarks (URLs)')}</li>
          <li>${_('All bookmark folders')}</li>
        </ul>
      `,
      onConfirm: () => this.resetBookmarks(),
    });
  }

  /**
   * Show confirmation modal for Mutes reset
   */
  private confirmResetMutes(): void {
    this.showResetModal({
      title: _('Reset Mutes?'),
      listName: _('mutes'),
      warningHtml: `
        <p>${_('This will delete <strong>your entire mute list</strong> including:')}</p>
        <ul>
          <li>${_('All muted users')}</li>
          <li>${_('All muted threads')}</li>
        </ul>
        <p style="margin-top: 0.5rem;">${_('Muted users will appear in your timeline again.')}</p>
      `,
      onConfirm: () => this.resetMutes(),
    });
  }

  /**
   * Show confirmation modal for Follows reset (with extra warnings)
   */
  private confirmResetFollows(): void {
    this.modalService.show({
      title: _('Reset Follows? (Critical)'),
      content: `
        <div class="danger-zone-modal">
          <div class="danger-zone-modal__warning danger-zone-modal__warning--critical">
            <strong>${_('Your follow list is critical!')}</strong> ${_('This determines who appears in your timeline.')}
          </div>

          <p style="margin: 1rem 0;"><strong>${_('Before you continue, make a backup:')}</strong></p>
          <ol style="margin: 0 0 1rem 1.5rem; line-height: 1.6;">
            <li>${_('Visit <a href="https://follows.nostr.com/" target="_blank">follows.nostr.com</a> in your browser')}</li>
            <li>${_('This automatically saves your contacts')}</li>
            <li>${_('Then come back and reset')}</li>
          </ol>

          <p style="margin-bottom: 1rem;">${_('This will delete <strong>all your follows</strong> from local storage.')}</p>

          <div class="danger-zone-modal__recovery">
            <strong>${_('Recovery options:')}</strong>
            <ul style="margin: 0.5rem 0 0 1.5rem;">
              <li>${_('If you synced to relays before: Go to List Settings → Manual Mode → "Sync from relays"')}</li>
              <li>${_('If you used follows.nostr.com: Visit the site again to restore')}</li>
              <li>${_('Otherwise: <strong>Data is lost forever</strong>')}</li>
            </ul>
          </div>

          <div style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1.5rem;">
            <button class="btn" data-action="cancel">${_('Cancel')}</button>
            <button class="btn btn--danger" data-action="confirm">${_('I Made a Backup, Reset Follows')}</button>
          </div>
        </div>
      `,
      width: '500px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true,
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
            <strong>${_('Recovery options:')}</strong>
            <ul style="margin: 0.5rem 0 0 1.5rem;">
              <li>${_('If you synced your %s to relays before: Go to List Settings → Switch to Manual Mode → "Sync from relays"', options.listName)}</li>
              <li>${_('Otherwise: <strong>Data is lost forever</strong>')}</li>
            </ul>
          </div>

          <div class="danger-zone-modal__warning">
            ${_('This action cannot be undone.')}
          </div>

          <div style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1.5rem;">
            <button class="btn" data-action="cancel">${_('Cancel')}</button>
            <button class="btn btn--danger" data-action="confirm">${_('Reset %s', options.listName)}</button>
          </div>
        </div>
      `,
      width: '500px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true,
    });

    this.bindModalActions(options.onConfirm);
  }

  /**
   * Bind modal action buttons
   */
  private bindModalActions(onConfirm: () => void): void {
    setTimeout(() => {
      document
        .querySelector('[data-action="cancel"]')
        ?.addEventListener('click', () => this.modalService.hide());

      document
        .querySelector('[data-action="confirm"]')
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
    const storage = PerAccountLocalStorage.getInstance();
    storage.remove(StorageKeys.TRIBES);
    storage.remove(StorageKeys.TRIBE_FOLDERS);
    storage.remove(StorageKeys.TRIBE_MEMBER_ASSIGNMENTS);
    storage.remove(StorageKeys.TRIBE_ROOT_ORDER);

    ToastService.show(_('Tribes reset. Reloading...'), 'success');
    setTimeout(() => window.location.reload(), 1000);
  }

  /**
   * Reset Bookmarks data
   */
  private resetBookmarks(): void {
    const storage = PerAccountLocalStorage.getInstance();
    storage.remove(StorageKeys.BOOKMARKS);
    storage.remove(StorageKeys.BOOKMARK_FOLDERS);
    storage.remove(StorageKeys.BOOKMARK_FOLDER_ASSIGNMENTS);
    storage.remove(StorageKeys.BOOKMARK_ROOT_ORDER);

    ToastService.show(_('Bookmarks reset. Reloading...'), 'success');
    setTimeout(() => window.location.reload(), 1000);
  }

  /**
   * Reset Mutes data
   */
  private resetMutes(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.MUTES);

    ToastService.show(_('Mutes reset. Reloading...'), 'success');
    setTimeout(() => window.location.reload(), 1000);
  }

  /**
   * Reset Follows data
   */
  private resetFollows(): void {
    PerAccountLocalStorage.getInstance().remove(StorageKeys.FOLLOWS);

    ToastService.show(_('Follows reset. Reloading...'), 'success');
    setTimeout(() => window.location.reload(), 1000);
  }

  /**
   * Unmount section and cleanup
   */
  public unmount(): void {
    this.enableSwitch = null;
    if (this.modeChangedSubscriptionId) {
      TypedEventBus.getInstance().off(this.modeChangedSubscriptionId);
      this.modeChangedSubscriptionId = null;
    }
  }
}
