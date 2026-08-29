/**
 * Sidebar addon order (per-account).
 *
 * The sidebar lists every registered addon. Users can reorder it (drag&drop on desktop, ▲▼ via
 * long-press on touch) to float their favourites to the top. The chosen order is an array of
 * addon ids in PerAccountLocalStorage; addons not yet in it (newly added ones) are appended
 * alphabetically by name, so the initial list is A→Z and always stays complete.
 */

import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../services/PerAccountLocalStorage';
import { ADDON_REGISTRY, type AddonRegistryEntry } from './registry';

export function getOrderedAddons(): AddonRegistryEntry[] {
  const saved = PerAccountLocalStorage.getInstance().get<string[]>(
    StorageKeys.ADDON_ORDER,
    []
  );
  return orderBy(saved);
}

/**
 * Same as getOrderedAddons() but for an explicit pubkey. Used on account switch, where the active
 * account in AuthService may not have settled yet — the login event carries the pubkey, so read it
 * directly to avoid any race.
 */
export function getOrderedAddonsForPubkey(
  pubkey: string
): AddonRegistryEntry[] {
  const saved = PerAccountLocalStorage.getInstance().getForPubkey<string[]>(
    StorageKeys.ADDON_ORDER,
    pubkey,
    []
  );
  return orderBy(saved);
}

function orderBy(saved: string[]): AddonRegistryEntry[] {
  const byId = new Map(ADDON_REGISTRY.map(a => [a.id, a]));

  const ordered: AddonRegistryEntry[] = [];
  for (const id of saved) {
    const entry = byId.get(id);
    if (entry) {
      ordered.push(entry);
      byId.delete(id);
    }
  }
  // Append any addons not covered by the saved order (new ones), alphabetically by name.
  const uncovered = ADDON_REGISTRY.filter(entry => byId.has(entry.id));
  uncovered.sort((a, b) => a.name.localeCompare(b.name));
  ordered.push(...uncovered);
  return ordered;
}

export function saveAddonOrder(ids: string[]): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.ADDON_ORDER, ids);
}

/**
 * True when the current account has a saved custom addon order (reordered at
 * least once and not reset since). An empty saved order means the default
 * (alphabetical) order applies.
 */
export function hasCustomAddonOrder(): boolean {
  return (
    PerAccountLocalStorage.getInstance().get<string[]>(
      StorageKeys.ADDON_ORDER,
      []
    ).length > 0
  );
}

/**
 * Drop the saved custom order — the sidebar falls back to the default
 * (alphabetical) order for the current account.
 */
export function resetAddonOrder(): void {
  PerAccountLocalStorage.getInstance().remove(StorageKeys.ADDON_ORDER);
}
