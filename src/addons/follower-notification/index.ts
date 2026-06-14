import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_follower_notification_enabled';

export function isFollowerNotificationEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.FOLLOWER_NOTIFICATION_ENABLED, null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setFollowerNotificationEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.FOLLOWER_NOTIFICATION_ENABLED, enabled);
  localStorage.setItem(STORAGE_KEY, 'false');
}
