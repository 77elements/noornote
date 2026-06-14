import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_hashtag_subscriptions_enabled';

export function isHashtagSubscriptionsEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.HASHTAG_SUBSCRIPTIONS_ENABLED, null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setHashtagSubscriptionsEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.HASHTAG_SUBSCRIPTIONS_ENABLED, enabled);
  localStorage.setItem(STORAGE_KEY, 'false');
}
