import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

export function isListSettingsEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.LIST_SETTINGS_ENABLED, false);
}

export function setListSettingsEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.LIST_SETTINGS_ENABLED, enabled);
}
