/**
 * Profile Recognition Add-On
 * Lightweight entry point — no heavy imports.
 * Only loads service/blinking code when feature is enabled.
 */

const STORAGE_KEY = 'noornote_profile_recognition_window';

/** Check if Profile Recognition is enabled (window > 0) */
export function isProfileRecognitionEnabled(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return true; // Default: enabled (90 days)
    return parseInt(stored, 10) !== 0;
  } catch {
    return true;
  }
}

/** Set the recognition window (0 = disabled) */
export function setProfileRecognitionWindow(value: number): void {
  localStorage.setItem(STORAGE_KEY, value.toString());
}
