/**
 * Note taking - cheap flag accessor (no heavy imports).
 *
 * Encrypted, offline-first note-taking app. Notes are
 * NIP-44 self-encrypted and synced as per-note NIP-78 (kind 30078) events.
 * Opt-in addon, disabled by default.
 */

import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';

export function isNoteTakingEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.NOTE_TAKING_ENABLED, false);
}

export function setNoteTakingEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.NOTE_TAKING_ENABLED, enabled);
}
