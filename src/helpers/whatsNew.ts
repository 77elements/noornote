/**
 * What's New sidebar widget — dismissal state, per account and per version.
 *
 * The widget ("What's new in v{APP_VERSION}") is dismissed via its x-button
 * and stays hidden for THAT version; when a new release ships, the version
 * changes and the widget reappears automatically.
 */

import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';

export function isWhatsNewDismissed(version: string): boolean {
  return (
    PerAccountLocalStorage.getInstance().get<string>(
      StorageKeys.WHATS_NEW_DISMISSED,
      ''
    ) === version
  );
}

export function setWhatsNewDismissed(version: string): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.WHATS_NEW_DISMISSED,
    version
  );
}
