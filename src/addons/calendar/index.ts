/**
 * Calendar - cheap flag accessor (no heavy imports).
 *
 * NIP-52 calendar addon: month/week/list grid over public calendar events
 * (kinds 31922/31923), collections (31924) and RSVPs (31925). Private
 * encrypted events (NIP-52E, phase 3) follow later. Opt-in, disabled default.
 */

import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';

export function isCalendarEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(
    StorageKeys.CALENDAR_ENABLED,
    false
  );
}

export function setCalendarEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(
    StorageKeys.CALENDAR_ENABLED,
    enabled
  );
}
