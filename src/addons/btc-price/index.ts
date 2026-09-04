import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_btc_price_enabled';

export function isBtcPriceEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.BTC_PRICE_ENABLED,
    null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setBtcPriceEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.BTC_PRICE_ENABLED,
    enabled
  );
  localStorage.setItem(STORAGE_KEY, 'false');
}

/** Show the "1 BTC = …" rate line in the sidebar (addon page display is always on). */
export function isBtcPriceSidebarWidget(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(
    StorageKeys.BTC_PRICE_SIDEBAR_WIDGET,
    false
  );
}

export function setBtcPriceSidebarWidget(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.BTC_PRICE_SIDEBAR_WIDGET,
    enabled
  );
}
