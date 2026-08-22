import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_badges_enabled';

export function isBadgesEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.BADGES_ENABLED,
    null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setBadgesEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.BADGES_ENABLED, enabled);
  localStorage.setItem(STORAGE_KEY, 'false');
}
