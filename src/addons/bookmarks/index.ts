import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

export function isBookmarksEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.BOOKMARKS_ADDON_ENABLED, false);
}

export function setBookmarksEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.BOOKMARKS_ADDON_ENABLED, enabled);
}
