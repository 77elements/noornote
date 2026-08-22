/**
 * DataSaverService — Global data-saving mode for mobile (Android APK)
 *
 * When enabled (default ON on Android), reduces data usage:
 * - Media (images/videos) shown as tap-to-load placeholders
 * - Relay connections and polling intervals reduced
 *
 * Not an addon — a core platform feature gated by PlatformService.isAndroid.
 * On Desktop and Web, this service is a no-op (always returns false).
 */

import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { PlatformService } from './PlatformService';

/**
 * Check if data saver mode is enabled.
 * Returns true only on Android when the user hasn't explicitly turned it off.
 * On Desktop/Web, always returns false.
 */
export function isDataSaverEnabled(): boolean {
  if (!PlatformService.getInstance().isAndroid) return false;
  return PerAccountLocalStorage.getInstance().get<boolean>(
    StorageKeys.DATA_SAVER_ENABLED,
    true
  );
}

/**
 * Toggle data saver mode (Android only).
 */
export function setDataSaverEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.DATA_SAVER_ENABLED,
    enabled
  );
}
