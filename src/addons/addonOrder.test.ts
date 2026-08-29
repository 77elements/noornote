import { describe, it, expect, vi, beforeEach } from 'vitest';

const { store } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
}));

vi.mock('../services/PerAccountLocalStorage', () => ({
  PerAccountLocalStorage: {
    getInstance: () => ({
      get: (key: string, def: unknown) =>
        store.has(key) ? store.get(key) : def,
      set: (key: string, v: unknown) => store.set(key, v),
      getForPubkey: (key: string, _pubkey: string, def: unknown) =>
        store.has(key) ? store.get(key) : def,
      remove: (key: string) => store.delete(key),
    }),
  },
  StorageKeys: { ADDON_ORDER: 'noornote_addon_order_map' },
}));

import { ADDON_REGISTRY } from './registry';
import {
  getOrderedAddons,
  getOrderedAddonsForPubkey,
  hasCustomAddonOrder,
  resetAddonOrder,
  saveAddonOrder,
} from './addonOrder';

const ORDER_KEY = 'noornote_addon_order_map';

describe('addonOrder', () => {
  beforeEach(() => store.clear());

  it('initial order (no saved order) is alphabetical by name, complete', () => {
    const ordered = getOrderedAddons();
    expect(ordered.map(a => a.id)).toHaveLength(ADDON_REGISTRY.length);
    expect(ordered[0].name).toBe('Analytics');
    const names = ordered.map(a => a.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  it('saved custom order wins; uncovered addons appended alphabetically', () => {
    store.set(ORDER_KEY, ['wallet-balance', 'bookmarks']);
    const ids = getOrderedAddons().map(a => a.id);
    expect(ids.slice(0, 2)).toEqual(['wallet-balance', 'bookmarks']);
    const rest = ids
      .slice(2)
      .map(id => ADDON_REGISTRY.find(a => a.id === id)!.name);
    expect([...rest].sort((a, b) => a.localeCompare(b))).toEqual(rest);
    expect(ids).toHaveLength(ADDON_REGISTRY.length);
  });

  it('getOrderedAddonsForPubkey reads the per-pubkey order', () => {
    store.set(ORDER_KEY, ['tribes']);
    expect(getOrderedAddonsForPubkey('pk')[0].id).toBe('tribes');
  });

  it('hasCustomAddonOrder tracks save and reset', () => {
    expect(hasCustomAddonOrder()).toBe(false);
    saveAddonOrder(['tribes', 'bookmarks']);
    expect(hasCustomAddonOrder()).toBe(true);
    resetAddonOrder();
    expect(hasCustomAddonOrder()).toBe(false);
    // Reset = back to the default (alphabetical) order.
    expect(getOrderedAddons()[0].name).toBe('Analytics');
  });
});
