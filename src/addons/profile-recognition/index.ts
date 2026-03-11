/**
 * Profile Recognition Add-On
 * Lightweight entry point — no heavy imports.
 * Only loads service/blinking code when feature is enabled.
 */

import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

/** Check if Profile Recognition is enabled (window > 0) */
export function isProfileRecognitionEnabled(): boolean {
  try {
    const stored = PerAccountLocalStorage.getInstance().get<number>(StorageKeys.PROFILE_RECOGNITION_WINDOW, 90);
    return stored !== 0;
  } catch {
    return true;
  }
}

/** Set the recognition window (0 = disabled) */
export function setProfileRecognitionWindow(value: number): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.PROFILE_RECOGNITION_WINDOW, value);
}
