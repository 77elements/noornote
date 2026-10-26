/**
 * Global back-bar visibility setting.
 *
 * The `.nn-back-bar` (global Back button at the bottom of the primary content
 * pane, mounted once by MainLayout) is ON by default. Users who find it
 * distracting can disable it in Settings → UI. The content clearance padding
 * (`.back-padder`) is intentionally INDEPENDENT of this setting — it never
 * changes, so disabling the bar only removes the overlay, not the reserved
 * scroll space.
 */

import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';

export function isBackBarEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(
    StorageKeys.BACK_BAR_ENABLED,
    true
  );
}

export function setBackBarEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.BACK_BAR_ENABLED,
    enabled
  );
}
