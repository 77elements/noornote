/**
 * Sidebar addon order (per-account).
 *
 * The sidebar lists every registered addon. Users can reorder it (drag&drop on desktop, ▲▼ via
 * long-press on touch) to float their favourites to the top. The chosen order is an array of
 * addon ids in PerAccountLocalStorage; addons not yet in it (newly added ones) are appended in
 * registry order, so the list always stays complete.
 */

import { PerAccountLocalStorage, StorageKeys } from '../services/PerAccountLocalStorage';
import { ADDON_REGISTRY, type AddonRegistryEntry } from './registry';

export function getOrderedAddons(): AddonRegistryEntry[] {
  const saved = PerAccountLocalStorage.getInstance().get<string[]>(StorageKeys.ADDON_ORDER, []);
  return orderBy(saved);
}

/**
 * Same as getOrderedAddons() but for an explicit pubkey. Used on account switch, where the active
 * account in AuthService may not have settled yet — the login event carries the pubkey, so read it
 * directly to avoid any race.
 */
export function getOrderedAddonsForPubkey(pubkey: string): AddonRegistryEntry[] {
  const saved = PerAccountLocalStorage.getInstance().getForPubkey<string[]>(StorageKeys.ADDON_ORDER, pubkey, []);
  return orderBy(saved);
}

function orderBy(saved: string[]): AddonRegistryEntry[] {
  const byId = new Map(ADDON_REGISTRY.map(a => [a.id, a]));

  const ordered: AddonRegistryEntry[] = [];
  for (const id of saved) {
    const entry = byId.get(id);
    if (entry) { ordered.push(entry); byId.delete(id); }
  }
  // Append any addons not covered by the saved order (new ones), keeping registry order.
  for (const entry of ADDON_REGISTRY) if (byId.has(entry.id)) ordered.push(entry);
  return ordered;
}

export function saveAddonOrder(ids: string[]): void {
  PerAccountLocalStorage.getInstance().set(StorageKeys.ADDON_ORDER, ids);
}
