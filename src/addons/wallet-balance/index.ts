import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

export function isWalletBalanceEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.WALLET_BALANCE_ADDON_ENABLED, false);
}

export function setWalletBalanceEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.WALLET_BALANCE_ADDON_ENABLED, enabled);
}
