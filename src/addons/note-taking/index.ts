/**
 * Note taking - cheap flag accessor (no heavy imports).
 *
 * Encrypted, offline-first note-taking app. Notes are
 * NIP-44 self-encrypted and synced as per-note NIP-78 (kind 30078) events.
 * Opt-in addon, disabled by default.
 */

import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';
import { isFocusUiEnabled } from '../../helpers/focusUiSetting';

export function isNoteTakingEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(
    StorageKeys.NOTE_TAKING_ENABLED,
    false
  );
}

export function setNoteTakingEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.NOTE_TAKING_ENABLED,
    enabled
  );
}

/**
 * Always-on reason for the v2 on-demand lifecycle (bootLoad + release
 * guard): a note's reminder still lies in the FUTURE — the scheduler must
 * stay alive to fire it. A PAST due time is not a reason (fired or
 * dismissed — on-demand again). v1 keeps the plain switch semantics.
 *
 * Reads the cheap mirror (NOTE_TAKING_MAX_REMINDER_AT — the latest
 * reminder ts, written on every note mutation + by the reminder scan);
 * the "mirror > now" comparison self-expires, so no timer is needed.
 */
export function isNoteTakingAutoLoaded(): boolean {
  if (!isFocusUiEnabled()) return isNoteTakingEnabled();
  const maxReminderAt = PerAccountLocalStorage.getInstance().get<number>(
    StorageKeys.NOTE_TAKING_MAX_REMINDER_AT,
    0
  );
  return maxReminderAt > Math.floor(Date.now() / 1000);
}
