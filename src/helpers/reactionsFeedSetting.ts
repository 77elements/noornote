/**
 * Show-reactions feed setting.
 *
 * A "reaction" here is a NIP-25 kind:7 event — someone liking/reacting to a
 * note. Ditto-style clients surface these as timeline entries by default;
 * NoorNote keeps them opt-in:
 *
 *  - Global switch (Settings → UI): shows ALL followed users' reactions in
 *    the main timeline (TV)
 *  - Per-user override (ProfileView checkbox): shows that one author's
 *    reactions in the TV, independent of the global switch
 *
 * Reactions never appear in the profile feed itself, tribes or relay-filter
 * views — the display surface is the TV only. The fetch gate is
 * {@link shouldFetchReactions} (global on OR any per-user entry exists), the
 * per-event keep-gate is {@link isReactionShownFrom}.
 */

import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';
import { diagLog } from '../services/DiagnosticLogger';

export function isShowReactionsEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(
    StorageKeys.SHOW_REACTIONS,
    false
  );
}

export function setShowReactionsEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.SHOW_REACTIONS, enabled);
  diagLog('system', 'Show-reactions setting changed', { global: enabled });
}

export function isShowReactionsFor(pubkey: string): boolean {
  const map = PerAccountLocalStorage.getInstance().get<Record<string, boolean>>(
    StorageKeys.SHOW_REACTIONS_USERS,
    {}
  );
  return map[pubkey] === true;
}

export function setShowReactionsFor(pubkey: string, enabled: boolean): void {
  const perAccount = PerAccountLocalStorage.getInstance();
  const map =
    perAccount.get<Record<string, boolean>>(
      StorageKeys.SHOW_REACTIONS_USERS,
      {}
    ) ?? {};
  if (enabled) map[pubkey] = true;
  else delete map[pubkey];
  perAccount.set(StorageKeys.SHOW_REACTIONS_USERS, map);
  diagLog('system', 'Show-reactions per-user setting changed', {
    pubkey,
    enabled,
  });
}

/**
 * Fetch gate for the TV feed: kind 7 belongs in the query when the global
 * switch is on OR at least one per-user override exists.
 */
export function shouldFetchReactions(): boolean {
  if (isShowReactionsEnabled()) return true;
  const map =
    PerAccountLocalStorage.getInstance().get<Record<string, boolean>>(
      StorageKeys.SHOW_REACTIONS_USERS,
      {}
    ) ?? {};
  return Object.values(map).some(Boolean);
}

/** All pubkeys with a per-user override (map keys with true). */
export function getShowReactionsPubkeys(): string[] {
  const map =
    PerAccountLocalStorage.getInstance().get<Record<string, boolean>>(
      StorageKeys.SHOW_REACTIONS_USERS,
      {}
    ) ?? {};
  return Object.keys(map).filter(pk => map[pk] === true);
}

/**
 * Keep gate for a single reaction event (the reactor's pubkey decides):
 * global switch on, or this author has the per-user override.
 */
export function isReactionShownFrom(pubkey: string): boolean {
  if (isShowReactionsEnabled()) return true;
  return isShowReactionsFor(pubkey);
}
