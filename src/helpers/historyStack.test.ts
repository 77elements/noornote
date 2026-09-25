import { describe, expect, it } from 'vitest';
import {
  collapseConsecutiveDuplicates,
  normalizeRoutePath,
  resolveLogicalParent,
  syncHistoryIndexToPath,
} from './historyStack';

describe('collapseConsecutiveDuplicates', () => {
  it('collapses reload-induced runs but keeps real revisits', () => {
    const { history, index } = collapseConsecutiveDuplicates(
      ['/', '/note/a', '/note/a', '/note/a', '/', '/note/a'],
      5
    );
    expect(history).toEqual(['/', '/note/a', '/', '/note/a']);
    expect(index).toBe(3);
  });

  it('maps an index pointing into a collapsed run to the run position', () => {
    const { history, index } = collapseConsecutiveDuplicates(
      ['/a', '/a', '/b'],
      1
    );
    expect(history).toEqual(['/a', '/b']);
    expect(index).toBe(0);
  });

  it('handles empty stacks', () => {
    const { history, index } = collapseConsecutiveDuplicates([], -1);
    expect(history).toEqual([]);
    expect(index).toBe(-1);
  });
});

describe('syncHistoryIndexToPath', () => {
  it('finds the path and returns its index', () => {
    const history = ['/', '/profile/abc', '/note/xyz'];
    expect(syncHistoryIndexToPath(history, 2, '/profile/abc')).toBe(1);
  });

  it('returns the LAST occurrence for repeated paths', () => {
    const history = ['/', '/note/a', '/', '/note/b'];
    expect(syncHistoryIndexToPath(history, 3, '/')).toBe(2);
  });

  it('returns the unchanged index when the path is not on the stack', () => {
    const history = ['/', '/note/a'];
    expect(syncHistoryIndexToPath(history, 1, '/elsewhere')).toBe(1);
  });

  it('handles an empty stack defensively', () => {
    expect(syncHistoryIndexToPath([], -1, '/')).toBe(-1);
  });
});

describe('normalizeRoutePath', () => {
  it('strips query, hash and trailing slashes', () => {
    expect(normalizeRoutePath('/note/a?scc=/profile/b#x')).toBe('/note/a');
    expect(normalizeRoutePath('/lists/')).toBe('/lists');
  });

  it('maps empty to root', () => {
    expect(normalizeRoutePath('')).toBe('/');
    expect(normalizeRoutePath('///')).toBe('/');
  });
});

describe('resolveLogicalParent', () => {
  it('returns the path itself for root views (no parent)', () => {
    expect(resolveLogicalParent('/')).toBe('/');
    expect(resolveLogicalParent('/settings')).toBe('/settings');
    expect(resolveLogicalParent('/messages')).toBe('/messages');
    expect(resolveLogicalParent('/lists/')).toBe('/lists');
  });

  it('maps note/article/profile deep links to the timeline', () => {
    expect(resolveLogicalParent('/note/nevent1abc')).toBe('/');
    expect(resolveLogicalParent('/article/naddr1abc')).toBe('/');
    expect(resolveLogicalParent('/profile/npub1abc')).toBe('/');
  });

  it('maps the reading-order book back to its profile', () => {
    expect(resolveLogicalParent('/profile/npub1abc/book')).toBe(
      '/profile/npub1abc'
    );
  });

  it('maps marketplace routes to /marketplace', () => {
    expect(resolveLogicalParent('/listing/naddr1abc')).toBe('/marketplace');
    expect(resolveLogicalParent('/write-listing')).toBe('/marketplace');
    expect(resolveLogicalParent('/write-listing/naddr1abc')).toBe(
      '/marketplace'
    );
    expect(resolveLogicalParent('/my-listings')).toBe('/marketplace');
  });

  it('maps sub-routes to their section root', () => {
    expect(resolveLogicalParent('/messages/abc123')).toBe('/messages');
    expect(resolveLogicalParent('/addons/calendar')).toBe('/addons');
    expect(resolveLogicalParent('/addons/nostr-majlis/stats')).toBe('/addons');
    expect(resolveLogicalParent('/settings/relays')).toBe('/settings');
  });

  it('falls back to / for unknown paths', () => {
    expect(resolveLogicalParent('/unknown/deep/route')).toBe('/');
    expect(resolveLogicalParent('/unknown')).toBe('/');
  });
});
