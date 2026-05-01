import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_nospress_enabled';

export function isNospressEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.NOSPRESS_ENABLED, null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setNospressEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.NOSPRESS_ENABLED, enabled);
  localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
}
