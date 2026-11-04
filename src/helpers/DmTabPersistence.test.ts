import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  clearDmTabIfLeaving,
  persistDmTab,
  readInitialDmTab,
} from './DmTabPersistence';

/**
 * Minimal sessionStorage stand-in — the helper only needs get/set/removeItem
 * and must survive its absence (node env, storage blocked).
 */
function mockSessionStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

describe('DmTabPersistence', () => {
  let storage: ReturnType<typeof mockSessionStorage> | null = null;

  beforeEach(() => {
    storage = mockSessionStorage();
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: storage,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: undefined,
      configurable: true,
    });
    storage = null;
  });

  describe('readInitialDmTab', () => {
    it('defaults to known when nothing is persisted', () => {
      expect(readInitialDmTab()).toBe('known');
    });

    it('restores a persisted unknown tab (back-navigation)', () => {
      persistDmTab('unknown');
      expect(readInitialDmTab()).toBe('unknown');
    });

    it('defaults to known when storage is unavailable', () => {
      Object.defineProperty(globalThis, 'sessionStorage', {
        value: undefined,
        configurable: true,
      });
      expect(readInitialDmTab()).toBe('known');
    });
  });

  describe('clearDmTabIfLeaving', () => {
    it('keeps the tab when navigating within the DM section', () => {
      persistDmTab('unknown');
      clearDmTabIfLeaving('/messages');
      clearDmTabIfLeaving('/messages/abc123');
      expect(readInitialDmTab()).toBe('unknown');
    });

    it('resets the tab when leaving the DM section', () => {
      persistDmTab('unknown');
      clearDmTabIfLeaving('/home');
      expect(readInitialDmTab()).toBe('known');
    });

    it('no-throw when storage is unavailable', () => {
      Object.defineProperty(globalThis, 'sessionStorage', {
        value: undefined,
        configurable: true,
      });
      expect(() => clearDmTabIfLeaving('/home')).not.toThrow();
    });
  });
});
