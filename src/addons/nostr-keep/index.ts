/**
 * Nostr Keep — cheap flag accessor (no heavy imports).
 *
 * Encrypted, offline-first note-taking ("Google Keep" style). Notes are
 * NIP-44 self-encrypted and synced as per-note NIP-78 (kind 30078) events.
 * Opt-in addon, disabled by default.
 */

import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

export function isNostrKeepEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.NOSTR_KEEP_ENABLED, false);
}

export function setNostrKeepEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.NOSTR_KEEP_ENABLED, enabled);
}
