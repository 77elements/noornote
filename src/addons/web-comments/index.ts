import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_web_comments_enabled';

export function isWebCommentsEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.WEB_COMMENTS_ENABLED, null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setWebCommentsEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.WEB_COMMENTS_ENABLED, enabled);
  localStorage.setItem(STORAGE_KEY, 'false');
}
