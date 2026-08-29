import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_analytics_enabled';

export function isAnalyticsEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.ANALYTICS_ENABLED,
    null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setAnalyticsEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.ANALYTICS_ENABLED,
    enabled
  );
  // Global fallback stays OFF permanently (addonEnabledStorage policy).
  localStorage.setItem(STORAGE_KEY, 'false');
}
