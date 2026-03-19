import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

export function isFollowPacksEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.FOLLOW_PACKS_ENABLED, false);
}

export function setFollowPacksEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.FOLLOW_PACKS_ENABLED, enabled);
}
