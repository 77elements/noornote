/**
 * reactionsFeedSetting — logic tests.
 * PerAccountLocalStorage is mocked (its real import pulls the AuthService
 * chain), same pattern as navModeSetting.test.ts. Node env — no DOM side
 * effects in this helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const storage = new Map<string, unknown>();

vi.mock('../services/PerAccountLocalStorage', () => ({
  StorageKeys: {
    SHOW_REACTIONS: 'noornote_show_reactions',
    SHOW_REACTIONS_USERS: 'noornote_show_reactions_users_map',
  },
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
  isShowReactionsEnabled,
  setShowReactionsEnabled,
  isShowReactionsFor,
  setShowReactionsFor,
  shouldFetchReactions,
  isReactionShownFrom,
  getShowReactionsPubkeys,
} from './reactionsFeedSetting';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);

describe('reactionsFeedSetting', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('is off by default (global and per-user)', () => {
    expect(isShowReactionsEnabled()).toBe(false);
    expect(isShowReactionsFor(PK_A)).toBe(false);
    expect(shouldFetchReactions()).toBe(false);
    expect(isReactionShownFrom(PK_A)).toBe(false);
  });

  it('global switch turns everything on', () => {
    setShowReactionsEnabled(true);
    expect(isShowReactionsEnabled()).toBe(true);
    expect(shouldFetchReactions()).toBe(true);
    expect(isReactionShownFrom(PK_A)).toBe(true);
    expect(isReactionShownFrom(PK_B)).toBe(true);
  });

  it('per-user override works without the global switch', () => {
    setShowReactionsFor(PK_A, true);
    expect(isShowReactionsEnabled()).toBe(false);
    expect(shouldFetchReactions()).toBe(true);
    expect(isReactionShownFrom(PK_A)).toBe(true);
    expect(isReactionShownFrom(PK_B)).toBe(false);
  });

  it('per-user override can be revoked', () => {
    setShowReactionsFor(PK_A, true);
    setShowReactionsFor(PK_A, false);
    expect(isShowReactionsFor(PK_A)).toBe(false);
    expect(shouldFetchReactions()).toBe(false);
  });

  it('per-user entries persist alongside each other', () => {
    setShowReactionsFor(PK_A, true);
    setShowReactionsFor(PK_B, true);
    setShowReactionsFor(PK_A, false);
    expect(isShowReactionsFor(PK_A)).toBe(false);
    expect(isShowReactionsFor(PK_B)).toBe(true);
  });

  it('getShowReactionsPubkeys lists only overridden pubkeys', () => {
    expect(getShowReactionsPubkeys()).toEqual([]);
    setShowReactionsFor(PK_A, true);
    setShowReactionsFor(PK_B, true);
    setShowReactionsFor(PK_A, false);
    expect(getShowReactionsPubkeys()).toEqual([PK_B]);
  });
});
