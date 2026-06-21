import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_bookmarks_addon_enabled';

export function isBookmarksEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.BOOKMARKS_ADDON_ENABLED, null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setBookmarksEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.BOOKMARKS_ADDON_ENABLED, enabled);
  // Global fallback used before login (per-account storage has no pubkey yet) — must
  // reflect the actual state, otherwise the sidebar entry stays hidden on next launch.
  localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
}
