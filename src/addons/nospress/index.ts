import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

const LEGACY_GLOBAL_KEY = 'noornote_nospress_enabled';

export function isNospressEnabled(): boolean {
  const enabled = PerAccountLocalStorage.getInstance().get<boolean>(
    StorageKeys.NOSPRESS_ENABLED, false
  );
  // One-time legacy cleanup: a previous version dual-wrote a global key as
  // fallback, which leaked the toggle across accounts. Remove on first read.
  if (localStorage.getItem(LEGACY_GLOBAL_KEY) !== null) {
    localStorage.removeItem(LEGACY_GLOBAL_KEY);
  }
  return enabled;
}

export function setNospressEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.NOSPRESS_ENABLED, enabled);
}
