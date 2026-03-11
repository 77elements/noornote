import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

export function isHashtagSubscriptionsEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.HASHTAG_SUBSCRIPTIONS_ENABLED, false);
}

export function setHashtagSubscriptionsEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.HASHTAG_SUBSCRIPTIONS_ENABLED, enabled);
}
