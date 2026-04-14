import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_scheduled_posts_enabled';

export function isScheduledPostsEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.SCHEDULED_POSTS_ENABLED, null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setScheduledPostsEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.SCHEDULED_POSTS_ENABLED, enabled);
  localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
}
