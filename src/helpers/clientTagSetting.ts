/**
 * Client tag opt-in (PER-ACCOUNT). Whether NoorNote adds a `client` tag to
 * signed events. Default OFF. One-time migration: the first active account
 * inherits the old global value, then the global key is removed so other
 * accounts default OFF.
 */

import { PerAccountLocalStorage, StorageKeys } from '../services/PerAccountLocalStorage';

const LEGACY_GLOBAL_KEY = 'noornote_client_tag_enabled';

/** One-time: hand the legacy global value to the active account, then drop it. */
function migrateLegacyIfNeeded(): void {
  const legacy = localStorage.getItem(LEGACY_GLOBAL_KEY);
  if (legacy === null) return; // already migrated / never set

  const store = PerAccountLocalStorage.getInstance();
  // Only seed the active account if it hasn't set its own value yet.
  if (store.get<boolean | null>(StorageKeys.CLIENT_TAG_ENABLED, null) === null) {
    store.set(StorageKeys.CLIENT_TAG_ENABLED, legacy === 'true'); // no-op if no active account
  }
  // Remove the global only once an active account actually holds a value, so we
  // never delete it before it has been handed off.
  if (store.get<boolean | null>(StorageKeys.CLIENT_TAG_ENABLED, null) !== null) {
    localStorage.removeItem(LEGACY_GLOBAL_KEY);
  }
}

export function isClientTagEnabled(): boolean {
  migrateLegacyIfNeeded();
  return PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.CLIENT_TAG_ENABLED, false);
}

export function setClientTagEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.CLIENT_TAG_ENABLED, enabled);
}
