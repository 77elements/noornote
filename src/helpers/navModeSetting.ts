/**
 * Navigation mode setting — circular nav wheel (default) vs. classic linear menu.
 *
 * The wheel is rendered by NavWheelPartial into the sidebar top slot. The old
 * `.primary-nav` list stays in the DOM as fallback (logged-out state, collapsed
 * icon rail, and users who flip the "Classic Menu" switch in UI Settings).
 *
 * Gating works via the `classic-nav` class on <html>: when present, CSS shows
 * the classic list and hides the wheel. Default (flag off / unset) = wheel.
 * Toggling applies instantly — no reload.
 */

import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';

export function isClassicMenuEnabled(): boolean {
  return PerAccountLocalStorage.getInstance().get<boolean>(
    StorageKeys.CLASSIC_MENU,
    false
  );
}

export function setClassicMenuEnabled(enabled: boolean): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.CLASSIC_MENU, enabled);
  applyNavMode();
}

/**
 * Sync the `classic-nav` gate class on <html> with the stored preference.
 * Called on boot (before sidebar wiring) and on every toggle.
 */
export function applyNavMode(): void {
  document.documentElement.classList.toggle(
    'classic-nav',
    isClassicMenuEnabled()
  );
}

/** True when the sidebar should render the nav wheel (default mode). */
export function isNavWheelActive(): boolean {
  return !isClassicMenuEnabled();
}

/** Map a router viewClass abbreviation to its wheel item id. */
export function viewClassToWheelItem(viewClass: string): string | null {
  const map: Record<string, string> = {
    tv: 'timeline', // Timeline View
    pv: 'profile', // Profile View
    nv: 'notifications', // Notifications View
    atv: 'articles', // Articles Timeline View
    av: 'articles', // Article View (single)
    aev: 'articles', // Article Editor View
    mv: 'messages', // Messages View
    cv: 'messages', // Conversation View
    sv: 'settings', // Settings View
    adv: 'addons', // Addons View
    lov: 'lists', // Lists Overview View
  };
  return map[viewClass] ?? null;
}
