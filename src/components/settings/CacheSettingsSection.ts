/**
 * CacheSettingsSection Component
 * Manages NDK cache configuration and clearing
 *
 * @purpose Configure NDK cache sizes and clear cache tables
 * @used-by SettingsView
 */

import { SettingsSection } from './SettingsSection';
import { ToastService } from '../../services/ToastService';
import { ErrorService } from '../../services/ErrorService';
import { ModalService } from '../../services/ModalService';
import { NotificationsCacheService } from '../../services/NotificationsCacheService';
import { PlatformService } from '../../services/PlatformService';

interface NDKCacheConfig {
  profileCacheSize: number;
  zapperCacheSize: number;
  nip05CacheSize: number;
  eventCacheSize: number;
  eventTagsCacheSize: number;
  saveSig: boolean;
}

const DEFAULT_CONFIG: NDKCacheConfig = {
  profileCacheSize: 100000,
  zapperCacheSize: 200,
  nip05CacheSize: 1000,
  eventCacheSize: 50000,
  eventTagsCacheSize: 100000,
  saveSig: false
};

const STORAGE_KEY = 'ndk_cache_config';

export class CacheSettingsSection extends SettingsSection {
  constructor() {
    super('cache-settings');
  }

  /**
   * Get current cache configuration from localStorage
   */
  private getConfig(): NDKCacheConfig {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_CONFIG;

    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  /**
   * Save cache configuration to localStorage
   */
  private saveConfig(config: NDKCacheConfig): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }

  /**
   * Mount section content into the DOM
   */
  public mount(parentContainer: HTMLElement): void {
    const contentContainer = this.getContentContainer(parentContainer);
    if (!contentContainer) return;

    const config = this.getConfig();
    const notificationsCacheService = NotificationsCacheService.getInstance();
    const notificationsCacheLimit = notificationsCacheService.getLimit();

    contentContainer.innerHTML = this.renderContent(config, notificationsCacheLimit);
    this.bindListeners(contentContainer);
  }

  /**
   * Render cache settings content
   */
  private renderContent(config: NDKCacheConfig, notificationsCacheLimit: number): string {
    const isDesktop = PlatformService.getInstance().isDesktop;

    return `
        <section class="section">
          <h3 class="subsection-title">Clear Cache Data</h3>
          <div class="form__info">
            <p>Select which cache tables to clear. This action cannot be undone.</p>
          </div>

          <div class="nn-checkbox-group">
            <label class="nn-checkbox">
              <input type="checkbox" value="events" />
              <span>Events</span>
            </label>
            <label class="nn-checkbox">
              <input type="checkbox" value="profiles" />
              <span>Profiles</span>
            </label>
            <label class="nn-checkbox">
              <input type="checkbox" value="eventTags" />
              <span>Event Tags</span>
            </label>
            <label class="nn-checkbox">
              <input type="checkbox" value="nip05" />
              <span>NIP-05</span>
            </label>
            <label class="nn-checkbox">
              <input type="checkbox" value="lnurl" />
              <span>Lightning Addresses</span>
            </label>
            <label class="nn-checkbox">
              <input type="checkbox" value="relayStatus" />
              <span>Relay Status</span>
            </label>
          </div>

          <div class="btn-container btn-container--btnright">
            <button class="btn btn--danger" id="clear-selected-btn">Clear Selected</button>
            <button class="btn btn--danger" id="clear-all-btn">Clear All & Reload</button>
          </div>
        </section>

        ${isDesktop ? `
        <section class="section">
          <h3 class="subsection-title">Notifications Cache</h3>
          <div class="form__row form__row--oneline">
            <label for="notifications-cache-size">Cache Size</label>
            <input
              type="number"
              id="notifications-cache-size"
              value="${notificationsCacheLimit}"
              min="10"
              max="1000"
              step="10"
            />
          </div>
          <p class="form__note">Maximum notifications to keep in localStorage (10-1000).</p>
        </section>

        <section class="section">
          <h3 class="subsection-title">NDK Cache Configuration</h3>
          <div class="form__info">
            <p>Configure NDK cache sizes. Changes require app reload to take effect.</p>
          </div>

          <div class="form__row form__row--oneline">
            <label for="profile-cache-size">Profile Cache Size</label>
            <input
              type="number"
              id="profile-cache-size"
              value="${config.profileCacheSize}"
              min="1000"
              max="500000"
              step="1000"
            />
          </div>

          <div class="form__row form__row--oneline">
            <label for="event-cache-size">Event Cache Size</label>
            <input
              type="number"
              id="event-cache-size"
              value="${config.eventCacheSize}"
              min="1000"
              max="200000"
              step="1000"
            />
          </div>

          <div class="form__row form__row--oneline">
            <label for="event-tags-cache-size">Event Tags Cache Size</label>
            <input
              type="number"
              id="event-tags-cache-size"
              value="${config.eventTagsCacheSize}"
              min="1000"
              max="500000"
              step="1000"
            />
          </div>

          <div class="form__row form__row--oneline">
            <label for="zapper-cache-size">Zapper Cache Size</label>
            <input
              type="number"
              id="zapper-cache-size"
              value="${config.zapperCacheSize}"
              min="50"
              max="5000"
              step="50"
            />
          </div>

          <div class="form__row form__row--oneline">
            <label for="nip05-cache-size">NIP-05 Cache Size</label>
            <input
              type="number"
              id="nip05-cache-size"
              value="${config.nip05CacheSize}"
              min="100"
              max="10000"
              step="100"
            />
          </div>

          <label class="nn-checkbox">
            <input
              type="checkbox"
              id="save-sig"
              ${config.saveSig ? 'checked' : ''}
            />
            <span>Save Event Signatures</span>
          </label>
          <p class="form__note">Store signatures in cache (increases storage usage).</p>
        </section>
        ` : ''}
    `;
  }

  /**
   * Bind event listeners
   */
  private bindListeners(contentContainer: HTMLElement): void {
    // Notifications cache size: save on blur / Enter
    const notifInput = contentContainer.querySelector('#notifications-cache-size') as HTMLInputElement;
    const saveNotifCache = () => {
      const val = parseInt(notifInput.value, 10);
      if (isNaN(val) || val < 10 || val > 1000) {
        ToastService.show('Invalid notifications cache size (10-1000)', 'error');
        return;
      }
      NotificationsCacheService.getInstance().setLimit(val);
      ToastService.show('Notifications cache size saved', 'success');
    };
    notifInput?.addEventListener('blur', saveNotifCache);
    notifInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveNotifCache(); });

    // NDK cache inputs: save on blur / Enter
    const ndkInputIds = [
      'profile-cache-size', 'event-cache-size', 'event-tags-cache-size',
      'zapper-cache-size', 'nip05-cache-size'
    ];
    const saveNDKConfig = () => {
      const config = this.readConfigFromDOM(contentContainer);
      if (!config) return;
      this.saveConfig(config);
      ToastService.show('Saved. Reload app for changes to take effect.', 'success');
    };

    ndkInputIds.forEach(id => {
      const input = contentContainer.querySelector(`#${id}`) as HTMLInputElement;
      input?.addEventListener('blur', saveNDKConfig);
      input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveNDKConfig(); });
    });

    // Save signatures checkbox: save on change
    const saveSigInput = contentContainer.querySelector('#save-sig') as HTMLInputElement;
    saveSigInput?.addEventListener('change', saveNDKConfig);

    // Clear selected tables button
    const clearSelectedBtn = contentContainer.querySelector('#clear-selected-btn');
    clearSelectedBtn?.addEventListener('click', () => this.handleClearSelected(contentContainer));

    // Clear all button
    const clearAllBtn = contentContainer.querySelector('#clear-all-btn');
    clearAllBtn?.addEventListener('click', () => this.handleClearAll());
  }

  /**
   * Read current NDK cache config values from DOM inputs
   */
  private readConfigFromDOM(contentContainer: HTMLElement): NDKCacheConfig | null {
    const getValue = (id: string): number => {
      const input = contentContainer.querySelector(`#${id}`) as HTMLInputElement;
      return parseInt(input.value, 10);
    };

    const profileCacheSize = getValue('profile-cache-size');
    const eventCacheSize = getValue('event-cache-size');
    const eventTagsCacheSize = getValue('event-tags-cache-size');
    const zapperCacheSize = getValue('zapper-cache-size');
    const nip05CacheSize = getValue('nip05-cache-size');
    const saveSig = (contentContainer.querySelector('#save-sig') as HTMLInputElement).checked;

    const isInvalidSize = (val: number, min: number): boolean => isNaN(val) || val < min;
    if (
      isInvalidSize(profileCacheSize, 1000) ||
      isInvalidSize(eventCacheSize, 1000) ||
      isInvalidSize(eventTagsCacheSize, 1000) ||
      isInvalidSize(zapperCacheSize, 50) ||
      isInvalidSize(nip05CacheSize, 100)
    ) {
      ToastService.show('Invalid cache size values', 'error');
      return null;
    }

    return { profileCacheSize, eventCacheSize, eventTagsCacheSize, zapperCacheSize, nip05CacheSize, saveSig };
  }

  /**
   * Show confirmation modal and execute action on confirm
   */
  private showConfirmationModal(
    title: string,
    bodyHtml: string,
    confirmLabel: string,
    onConfirm: () => Promise<void>
  ): void {
    const modalService = ModalService.getInstance();

    modalService.show({
      title,
      content: `
        <div style="padding: 1rem 0;">
          ${bodyHtml}
          <p style="color: var(--color-red);">This action cannot be undone.</p>
        </div>
        <div style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1.5rem;">
          <button class="btn" data-action="cancel">Cancel</button>
          <button class="btn btn--danger" data-action="confirm">${confirmLabel}</button>
        </div>
      `,
      width: '500px',
      closeOnOverlay: true,
      closeOnEsc: true
    });

    setTimeout(() => {
      document.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
        modalService.hide();
      });

      document.querySelector('[data-action="confirm"]')?.addEventListener('click', async () => {
        modalService.hide();
        await onConfirm();
      });
    }, 100);
  }

  /**
   * Handle clear selected tables
   */
  private handleClearSelected(contentContainer: HTMLElement): void {
    const checkboxes = contentContainer.querySelectorAll(
      '.nn-checkbox input[type="checkbox"]:checked'
    ) as NodeListOf<HTMLInputElement>;

    if (checkboxes.length === 0) {
      ToastService.show('Please select at least one table to clear', 'warning');
      return;
    }

    const tableNames = Array.from(checkboxes).map(cb => cb.value);

    this.showConfirmationModal(
      'Clear Selected Cache Tables?',
      `<p style="margin-bottom: 1rem;">This will clear ${tableNames.length} table(s): ${tableNames.join(', ')}.</p>`,
      'Clear Tables',
      async () => {
        try {
          const { db } = await import('@nostr-dev-kit/ndk-cache-dexie');

          for (const tableName of tableNames) {
            if ((db as any)[tableName]) {
              await (db as any)[tableName].clear();
            }
          }

          checkboxes.forEach(cb => cb.checked = false);
          ToastService.show(`Successfully cleared ${tableNames.length} cache table(s)`, 'success');
        } catch (error) {
          ErrorService.handle(error, 'CacheSettingsSection.handleClearSelected', true, 'Failed to clear cache tables');
        }
      }
    );
  }

  /**
   * Handle clear all cache (delete entire database)
   */
  private handleClearAll(): void {
    this.showConfirmationModal(
      'Clear All Cache & Reload?',
      `<p style="margin-bottom: 1rem;">This will clear all safe cache tables and reload the app.</p>
       <p class="small">
         Excludes: Unpublished events and decrypted messages (protected from accidental deletion).
       </p>`,
      'Clear Cache & Reload',
      async () => {
        try {
          const { db } = await import('@nostr-dev-kit/ndk-cache-dexie');

          await Promise.all([
            db.events.clear(),
            db.profiles.clear(),
            db.eventTags.clear(),
            db.nip05.clear(),
            db.lnurl.clear(),
            db.relayStatus.clear()
          ]);

          ToastService.show('Cache cleared successfully. Reloading...', 'success');
          setTimeout(() => window.location.reload(), 1000);
        } catch (error) {
          ErrorService.handle(error, 'CacheSettingsSection.handleClearAll', true, 'Failed to clear cache');
        }
      }
    );
  }

  /**
   * Unmount section and cleanup
   */
  public unmount(): void {
    // Cleanup if needed
  }
}
