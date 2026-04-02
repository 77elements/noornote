import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_wallet_balance_addon_enabled';

export function isWalletBalanceEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.WALLET_BALANCE_ADDON_ENABLED, null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setWalletBalanceEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.WALLET_BALANCE_ADDON_ENABLED, enabled);
  localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
}
