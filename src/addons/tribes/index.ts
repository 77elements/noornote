import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

export function isTribesEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.TRIBES_ADDON_ENABLED, false);
}

export function setTribesEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.TRIBES_ADDON_ENABLED, enabled);
}
