import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

const STORAGE_KEY = 'noornote_nostrord_enabled';
const ARMADA_STORAGE_KEY = 'noornote_armada_enabled';

export function isNostrordEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.NOSTRORD_ENABLED, null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setNostrordEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.NOSTRORD_ENABLED, enabled);
  localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
}

/**
 * Armada / Concord encrypted-community notifications.
 *
 * Sprint 1 status: UI toggle is live, polling pipeline is scaffolded but not
 * yet emitting notifications — see `docs/todos/armada-concord-groups-addon.md`
 * Sprint 2 (community registry) + Sprint 3 (gift-wrap decrypt) + Sprint 4
 * (polling). The flag is already wired through the runtime so the moment
 * `ArmadaService` lands, toggling this on is all the user does to opt in.
 */
export function isArmadaEnabled(): boolean {
  const perAccount = PerAccountLocalStorage.getInstance().get<boolean | null>(
    StorageKeys.ARMADA_ENABLED, null
  );
  if (perAccount !== null) return perAccount;
  return localStorage.getItem(ARMADA_STORAGE_KEY) === 'true';
}

export function setArmadaEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.ARMADA_ENABLED, enabled);
  localStorage.setItem(ARMADA_STORAGE_KEY, enabled ? 'true' : 'false');
}
