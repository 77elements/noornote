/**
 * ListSyncMode
 * Renders sync control buttons for list views (Follows, Bookmarks, Mutes)
 *
 * @purpose Centralized rendering of sync buttons based on sync mode
 * @used-by BaseListSecondaryManager, BookmarkSecondaryManager
 */

import { EventBus } from '../services/EventBus';
import { ToastService } from '../services/ToastService';
import { PlatformService } from '../services/PlatformService';

export type ListSyncMode = 'manual' | 'easy';

const STORAGE_KEY = 'noornote_list_sync_mode';
const MODE_CHANGED_EVENT = 'list-sync-mode:changed';

/**
 * Get current sync mode from localStorage
 */
export function getListSyncMode(): ListSyncMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'manual') return 'manual';
  return 'easy'; // default for new users
}

/**
 * Set sync mode in localStorage and emit change event
 */
export function setListSyncMode(mode: ListSyncMode): void {
  const previousMode = getListSyncMode();
  localStorage.setItem(STORAGE_KEY, mode);

  if (previousMode !== mode) {
    EventBus.getInstance().emit(MODE_CHANGED_EVENT, { mode });
  }
}

/**
 * Check if Easy Mode is enabled
 */
export function isEasyMode(): boolean {
  return getListSyncMode() === 'easy';
}

/**
 * Render sync control buttons based on current mode
 *
 * Manual Mode: 4 buttons (Sync from Relays, Sync to Relays, Save to File, Restore from File)
 * Easy Mode: 1 button (Save to File - manual backup option)
 */
/**
 * Switch sync mode and show toast notification
 * @returns The new mode
 */
export function switchSyncMode(): ListSyncMode {
  const currentMode = getListSyncMode();
  const newMode = currentMode === 'easy' ? 'manual' : 'easy';
  setListSyncMode(newMode);
  return newMode;
}

/**
 * Bind click handler for switch sync mode links
 * @param container - Container element to search for links
 * @param onSwitch - Callback after mode is switched (for re-rendering)
 */
export function bindSwitchSyncModeLink(container: HTMLElement, onSwitch: () => void): void {
  container.querySelectorAll('.switch-sync-mode-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const newMode = switchSyncMode();
      const modeLabel = newMode === 'easy' ? 'Easy Mode' : 'Manual Mode';
      ToastService.show(`Switched to ${modeLabel}`, 'success');
      onSwitch();
    });
  });
}

export function renderListSyncButtons(): string {
  const mode = getListSyncMode();
  const isTauri = PlatformService.getInstance().isTauri;

  if (mode === 'easy') {
    if (isTauri) {
      // Desktop: local backup + relays
      return `
        <div class="list-sync-controls list-sync-controls--easy">
          <button class="btn btn--mini btn--passive save-to-file-btn">
            Backup list to file
          </button>
        </div>
        <p class="list-sync-info list-sync-info--easy">
          Easy Mode: Changes are automatically synced to your local backup and relays. <a href="#" class="switch-sync-mode-link">Switch to manual mode</a>
        </p>
      `;
    } else {
      // Web/Phone: relays only
      return `
        <div class="list-sync-controls list-sync-controls--easy">
          <button class="btn btn--mini btn--passive save-to-file-btn">
            Backup list to file
          </button>
        </div>
        <p class="list-sync-info list-sync-info--easy">
          Easy Mode: Changes are automatically synced to and from relays. <a href="#" class="switch-sync-mode-link">Switch to manual mode</a>
        </p>
      `;
    }
  }

  // Manual Mode (default)
  return `
    <div class="list-sync-controls">
      <button class="btn btn--mini btn--passive sync-from-relays-btn">
        Sync from Relays
      </button>
      <button class="btn btn--mini btn--passive sync-to-relays-btn">
        Sync to Relays
      </button>
      <button class="btn btn--mini btn--passive save-to-file-btn">
        Save to File
      </button>
      <button class="btn btn--mini btn--passive restore-from-file-btn">
        Restore from File
      </button>
    </div>
    <p class="list-sync-info">
      This list is stored in 3 places: on your hard drive - in the NoorNote app - on the relays. You can use the buttons up there to control how the list stays synced across those three. <a href="#" class="switch-sync-mode-link">Switch to easy mode</a>
    </p>
  `;
}
