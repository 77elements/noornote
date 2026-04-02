import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_extended_follows_addon_enabled';

export function isExtendedFollowsEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.EXTENDED_FOLLOWS_ADDON_ENABLED, null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setExtendedFollowsEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.EXTENDED_FOLLOWS_ADDON_ENABLED, enabled);
  localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
}
