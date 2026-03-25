import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

export function isNostrInEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.NOSTRIN_ENABLED, false);
}

export function setNostrInEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.NOSTRIN_ENABLED, enabled);
}
