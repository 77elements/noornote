import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

export function isExtendedFollowsEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.EXTENDED_FOLLOWS_ADDON_ENABLED, false);
}

export function setExtendedFollowsEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.EXTENDED_FOLLOWS_ADDON_ENABLED, enabled);
}
