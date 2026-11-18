import { describe, expect, it } from 'vitest';
import {
  canHideObject,
  sanitizeHiddenIds,
  visibleDomainIds,
} from './focusDependencyGraph';

/**
 * Registry stub mirroring the FOCUS_DOMAINS ids (subset + edge-less ids).
 * The graph data under test lives in FOCUS_DOMAIN_REQUIRES/LOCKED_DOMAINS.
 */
const ALL_IDS = [
  'social',
  'articles',
  'media',
  'recipes',
  'messages',
  'notifications',
  'follows',
  'muted',
  'bookmarks',
  'profile',
  'bulk-delete',
];

describe('canHideObject', () => {
  it('never hides a locked domain (profile)', () => {
    expect(canHideObject('profile', ALL_IDS, [])).toBe(false);
  });

  it('never offers hide for an already hidden domain', () => {
    expect(canHideObject('follows', ALL_IDS, ['follows'])).toBe(false);
  });

  it('hides edge-less domains while everything is visible', () => {
    // Nothing requires bulk-delete, it requires nothing blocking.
    expect(canHideObject('bulk-delete', ALL_IDS, [])).toBe(true);
    expect(canHideObject('bookmarks', ALL_IDS, [])).toBe(true);
  });

  it('blocks a domain required by a visible object (notifications)', () => {
    expect(canHideObject('notifications', ALL_IDS, [])).toBe(false);
  });

  it('unblocks notifications once no visible interactive object remains', () => {
    const hidden = ['social', 'articles', 'media', 'recipes'];
    expect(canHideObject('notifications', ALL_IDS, hidden)).toBe(true);
  });

  it('unblocks follows/muted once social is hidden', () => {
    expect(canHideObject('follows', ALL_IDS, ['social'])).toBe(true);
    expect(canHideObject('muted', ALL_IDS, ['social'])).toBe(true);
  });

  it('keeps notifications blocked while articles alone is visible', () => {
    expect(canHideObject('notifications', ALL_IDS, ['social'])).toBe(false);
  });
});

describe('visibleDomainIds', () => {
  it('returns the registry minus the hidden set', () => {
    expect(visibleDomainIds(ALL_IDS, ['social', 'bulk-delete'])).toEqual([
      'articles',
      'media',
      'recipes',
      'messages',
      'notifications',
      'follows',
      'muted',
      'bookmarks',
      'profile',
    ]);
  });
});

describe('sanitizeHiddenIds', () => {
  it('drops unknown ids and the locked domain', () => {
    expect(
      sanitizeHiddenIds(ALL_IDS, ['bookmarks', 'ghost', 'profile', 42])
    ).toEqual(['bookmarks']);
  });

  it('drops ids required by a visible object (stale storage)', () => {
    expect(sanitizeHiddenIds(ALL_IDS, ['notifications', 'follows'])).toEqual(
      []
    );
  });

  it('keeps ids whose requirers are themselves hidden', () => {
    // social hidden → its requirements (follows/muted) may stay hidden —
    // but only while NO other visible object needs them (articles/media
    // stay visible here → notifications still blocked).
    expect(sanitizeHiddenIds(ALL_IDS, ['social', 'follows', 'muted'])).toEqual([
      'social',
      'follows',
      'muted',
    ]);
    // All interactive requirers hidden → notifications may stay hidden.
    expect(
      sanitizeHiddenIds(ALL_IDS, [
        'social',
        'articles',
        'media',
        'recipes',
        'notifications',
      ])
    ).toEqual(['social', 'articles', 'media', 'recipes', 'notifications']);
  });

  it('resolves cascades iteratively (requirer dropped frees the required)', () => {
    // recipes requires articles; recipes visible → articles dropped. That
    // does NOT free notifications (recipes itself requires notifications).
    expect(sanitizeHiddenIds(ALL_IDS, ['articles', 'notifications'])).toEqual(
      []
    );
  });

  it('accepts non-array storage as empty', () => {
    expect(sanitizeHiddenIds(ALL_IDS, null)).toEqual([]);
    expect(sanitizeHiddenIds(ALL_IDS, 'nope')).toEqual([]);
  });
});
