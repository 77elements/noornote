/**
 * navModeSetting — logic tests.
 * PerAccountLocalStorage is mocked (its real import pulls the AuthService
 * chain). jsdom opt-in because setClassicMenuEnabled() toggles the gate
 * class on <html>.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const storage = new Map<string, unknown>();

vi.mock('../services/PerAccountLocalStorage', () => ({
  StorageKeys: { CLASSIC_MENU: 'noornote_classic_menu_map' },
  PerAccountLocalStorage: {
    getInstance: () => ({
      get: (key: string, fallback: unknown) =>
        storage.has(key) ? storage.get(key) : fallback,
      set: (key: string, value: unknown) => {
        storage.set(key, value);
      },
    }),
  },
}));

vi.mock('../services/DiagnosticLogger', () => ({
  diagLog: vi.fn(),
}));

import {
  isClassicMenuEnabled,
  setClassicMenuEnabled,
  isNavWheelActive,
  viewClassToWheelItem,
} from './navModeSetting';

describe('viewClassToWheelItem', () => {
  it('maps every router viewClass to its wheel item', () => {
    expect(viewClassToWheelItem('tv')).toBe('timeline');
    expect(viewClassToWheelItem('pv')).toBe('profile');
    expect(viewClassToWheelItem('nv')).toBe('notifications');
    expect(viewClassToWheelItem('atv')).toBe('articles');
    expect(viewClassToWheelItem('av')).toBe('articles');
    expect(viewClassToWheelItem('aev')).toBe('articles');
    expect(viewClassToWheelItem('mv')).toBe('messages');
    expect(viewClassToWheelItem('cv')).toBe('messages');
    expect(viewClassToWheelItem('sv')).toBe('settings');
    expect(viewClassToWheelItem('adv')).toBe('addons');
    expect(viewClassToWheelItem('lov')).toBe('lists');
  });

  it('returns null for unknown viewClasses', () => {
    expect(viewClassToWheelItem('snv')).toBeNull();
    expect(viewClassToWheelItem('')).toBeNull();
  });
});

describe('classic menu flag', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('defaults to wheel mode (classic off)', () => {
    expect(isClassicMenuEnabled()).toBe(false);
    expect(isNavWheelActive()).toBe(true);
  });

  it('setClassicMenuEnabled(true) flips to classic', () => {
    setClassicMenuEnabled(true);
    expect(isClassicMenuEnabled()).toBe(true);
    expect(isNavWheelActive()).toBe(false);
  });

  it('setClassicMenuEnabled syncs the html.classic-nav gate', () => {
    setClassicMenuEnabled(true);
    expect(document.documentElement.classList.contains('classic-nav')).toBe(
      true
    );
    setClassicMenuEnabled(false);
    expect(document.documentElement.classList.contains('classic-nav')).toBe(
      false
    );
  });
});
