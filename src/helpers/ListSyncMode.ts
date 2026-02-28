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

/**
 * Bind all sync buttons in a container to their respective handlers.
 * Replaces the identical bindSyncButtons() method in all 4 list files.
 */
export function bindListSyncButtons(
  container: HTMLElement,
  handlers: {
    onSyncFromRelays: () => void;
    onSyncToRelays: () => void;
    onSaveToFile: () => void;
    onRestoreFromFile: () => void;
    onSwitchMode: () => void;
  }
): void {
  const bind = (cls: string, handler: () => void) => {
    container.querySelectorAll(`.${cls}`).forEach(btn => btn.addEventListener('click', handler));
  };
  bind('sync-from-relays-btn', handlers.onSyncFromRelays);
  bind('sync-to-relays-btn', handlers.onSyncToRelays);
  bind('save-to-file-btn', handlers.onSaveToFile);
  bind('restore-from-file-btn', handlers.onRestoreFromFile);
  bindSwitchSyncModeLink(container, handlers.onSwitchMode);
}

export function renderListSyncButtons(): string {
  const mode = getListSyncMode();
  const platform = PlatformService.getInstance();
  const isDesktop = platform.isTauri && !platform.isAndroid;

  if (mode === 'easy') {
    const syncText = isDesktop
      ? 'Easy Mode: Changes are automatically synced to your local backup and relays.'
      : 'Easy Mode: Changes are automatically synced to and from relays.';

    return `
      <p class="list-sync-info list-sync-info--easy">
        ${syncText}
        <br>
        <a href="#" class="save-to-file-btn">Backup list to file</a> | <a href="#" class="switch-sync-mode-link">Switch to manual mode</a>
      </p>
    `;
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
