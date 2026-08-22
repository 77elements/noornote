/**
 * Profile Recognition Add-On
 * Lightweight entry point — no heavy imports.
 * Only loads service/blinking code when feature is enabled.
 */

import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_profile_recognition_enabled';

/** Check if Profile Recognition is enabled (window > 0) */
export function isProfileRecognitionEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<number | null>(
    StorageKeys.PROFILE_RECOGNITION_WINDOW,
    null
  );
  if (perAccount !== null) return perAccount !== 0;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== null) return raw === 'true';
  // Default OFF: every addon starts disabled for a new user.
  return false;
}

/** Set the recognition window (0 = disabled) */
export function setProfileRecognitionWindow(value: number): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.PROFILE_RECOGNITION_WINDOW,
    value
  );
  localStorage.setItem(STORAGE_KEY, 'false');
}
