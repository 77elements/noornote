import { describe, expect, it } from 'vitest';
import { parseFocusUrl, stripSccQueryParam } from './focusUrlState';

/**
 * Regression tests for the focus URL → state mapper (v2 history sync):
 * back/forward/deep-link turn a path back into shell state. The
 * /note/:nevent detail route is shared by social + notifications — the
 * active object resolves the ambiguity.
 */
describe('parseFocusUrl', () => {
  it('maps the object list routes', () => {
    expect(parseFocusUrl('/timeline')).toEqual({
      defId: 'social',
      kind: 'list',
    });
    expect(parseFocusUrl('/articles')).toEqual({
      defId: 'articles',
      kind: 'list',
    });
    expect(parseFocusUrl('/articles/post')).toEqual({
      defId: 'articles',
      kind: 'secondary',
    });
    expect(parseFocusUrl('/notifications')).toEqual({
      defId: 'notifications',
      kind: 'list',
    });
    expect(parseFocusUrl('/messages')).toEqual({
      defId: 'messages',
      kind: 'list',
    });
    expect(parseFocusUrl('/lists')).toEqual({
      defId: 'bookmarks',
      kind: 'list',
    });
    expect(parseFocusUrl('/tribes')).toEqual({
      defId: 'tribes',
      kind: 'list',
    });
    expect(parseFocusUrl('/follow-list')).toEqual({
      defId: 'follows',
      kind: 'list',
    });
    expect(parseFocusUrl('/media')).toEqual({
      defId: 'media',
      kind: 'list',
    });
    expect(parseFocusUrl('/muted')).toEqual({
      defId: 'muted',
      kind: 'list',
    });
    expect(parseFocusUrl('/live-streams')).toEqual({
      defId: 'live-streams',
      kind: 'list',
    });
    expect(parseFocusUrl('/live-streams/stream/naddr1abc')).toEqual({
      defId: 'live-streams',
      kind: 'detail',
      param: 'naddr1abc',
    });
    expect(parseFocusUrl('/media/post')).toEqual({
      defId: 'media',
      kind: 'secondary',
    });
    expect(parseFocusUrl('/marketplace')).toEqual({
      defId: 'marketplace',
      kind: 'list',
    });
    expect(parseFocusUrl('/marketplace/post')).toEqual({
      defId: 'marketplace',
      kind: 'secondary',
    });
    expect(parseFocusUrl('/marketplace/edit/naddr1abc')).toEqual({
      defId: 'marketplace',
      kind: 'secondary',
      param: 'naddr1abc',
    });
    expect(parseFocusUrl('/listing/naddr1abc')).toEqual({
      defId: 'marketplace',
      kind: 'detail',
      param: 'naddr1abc',
    });
    expect(parseFocusUrl('/profile')).toEqual({
      defId: 'profile',
      kind: 'list',
    });
  });

  it('maps the detail routes with their params', () => {
    expect(parseFocusUrl('/note/nevent1qqq')).toEqual({
      defId: 'social',
      kind: 'detail',
      param: 'nevent1qqq',
    });
    expect(parseFocusUrl('/article/naddr1abc')).toEqual({
      defId: 'articles',
      kind: 'detail',
      param: 'naddr1abc',
    });
    expect(parseFocusUrl('/messages/pubkey123')).toEqual({
      defId: 'messages',
      kind: 'detail',
      param: 'pubkey123',
    });
    expect(parseFocusUrl('/profile/npub1xyz')).toEqual({
      defId: 'profile',
      kind: 'detail',
      param: 'npub1xyz',
    });
  });

  it('resolves the shared /note route via the active object', () => {
    expect(parseFocusUrl('/note/nevent1', 'notifications')).toEqual({
      defId: 'notifications',
      kind: 'detail',
      param: 'nevent1',
    });
    expect(parseFocusUrl('/note/nevent1', 'social')).toEqual({
      defId: 'social',
      kind: 'detail',
      param: 'nevent1',
    });
    expect(parseFocusUrl('/note/nevent1', 'articles')).toEqual({
      defId: 'social', // default owner when the active object is unrelated
      kind: 'detail',
      param: 'nevent1',
    });
  });

  it('maps the profile editor secondary', () => {
    expect(parseFocusUrl('/profile/edit')).toEqual({
      defId: 'profile',
      kind: 'secondary',
    });
  });

  it('maps the addon object list routes (short canonical forms)', () => {
    expect(parseFocusUrl('/custom-emojis')).toEqual({
      defId: 'custom-emojis',
      kind: 'list',
    });
    expect(parseFocusUrl('/scheduled-posts')).toEqual({
      defId: 'scheduled-posts',
      kind: 'list',
    });
    expect(parseFocusUrl('/nostr-majlis')).toEqual({
      defId: 'majlis',
      kind: 'list',
    });
    // Classic slug without hyphen.
    expect(parseFocusUrl('/wordfilter')).toEqual({
      defId: 'word-filter',
      kind: 'list',
    });
    expect(parseFocusUrl('/wallet-balance')).toEqual({
      defId: 'wallet-balance',
      kind: 'list',
    });
    expect(parseFocusUrl('/follow-packs')).toEqual({
      defId: 'follow-packs',
      kind: 'list',
    });
    expect(parseFocusUrl('/calendar')).toEqual({
      defId: 'calendar',
      kind: 'list',
    });
    expect(parseFocusUrl('/note-taking')).toEqual({
      defId: 'note-taking',
      kind: 'list',
    });
  });

  it('keeps the classic /addons/:slug aliases working', () => {
    expect(parseFocusUrl('/addons/custom-emojis')).toEqual({
      defId: 'custom-emojis',
      kind: 'list',
    });
    expect(parseFocusUrl('/addons/scheduled-posts')).toEqual({
      defId: 'scheduled-posts',
      kind: 'list',
    });
    expect(parseFocusUrl('/addons/nostr-majlis')).toEqual({
      defId: 'majlis',
      kind: 'list',
    });
    // Classic slug without hyphen.
    expect(parseFocusUrl('/addons/wordfilter')).toEqual({
      defId: 'word-filter',
      kind: 'list',
    });
    // Classic alias of the canonical /live-streams.
    expect(parseFocusUrl('/addons/live-streams')).toEqual({
      defId: 'live-streams',
      kind: 'list',
    });
    expect(parseFocusUrl('/addons/wallet-balance')).toEqual({
      defId: 'wallet-balance',
      kind: 'list',
    });
    expect(parseFocusUrl('/addons/follow-packs')).toEqual({
      defId: 'follow-packs',
      kind: 'list',
    });
    expect(parseFocusUrl('/addons/calendar')).toEqual({
      defId: 'calendar',
      kind: 'list',
    });
  });

  it('maps the search object', () => {
    expect(parseFocusUrl('/search')).toEqual({
      defId: 'search',
      kind: 'list',
    });
  });

  it('maps the addon object param deep links', () => {
    // Canonical short tab deep links.
    expect(parseFocusUrl('/nostr-majlis/daily-ayah')).toEqual({
      defId: 'majlis',
      kind: 'detail',
      param: 'daily-ayah',
    });
    expect(parseFocusUrl('/calendar/booking')).toEqual({
      defId: 'calendar',
      kind: 'detail',
      param: 'booking',
    });
    expect(parseFocusUrl('/feedback-board/naddr1abc')).toEqual({
      defId: 'feedback-board',
      kind: 'detail',
      param: 'naddr1abc',
    });
    // Classic aliases keep working.
    expect(parseFocusUrl('/addons/nostr-majlis/daily-ayah')).toEqual({
      defId: 'majlis',
      kind: 'detail',
      param: 'daily-ayah',
    });
    expect(parseFocusUrl('/addons/calendar/booking')).toEqual({
      defId: 'calendar',
      kind: 'detail',
      param: 'booking',
    });
    expect(parseFocusUrl('/addons/feedback-board/naddr1abc')).toEqual({
      defId: 'feedback-board',
      kind: 'detail',
      param: 'naddr1abc',
    });
    expect(parseFocusUrl('/follow-pack/naddr1abc')).toEqual({
      defId: 'follow-packs',
      kind: 'detail',
      param: 'naddr1abc',
    });
    expect(parseFocusUrl('/addons/live-streams/stream/naddr1abc')).toEqual({
      defId: 'live-streams',
      kind: 'detail',
      param: 'naddr1abc',
    });
  });

  it('maps the marketplace dashboard', () => {
    expect(parseFocusUrl('/my-listings')).toEqual({
      defId: 'marketplace',
      kind: 'detail',
      param: 'my-listings',
    });
  });

  it('returns null for non-shell paths', () => {
    expect(parseFocusUrl('/')).toBeNull();
    expect(parseFocusUrl('/settings/privacy')).toBeNull();
    expect(parseFocusUrl('/addons')).toBeNull();
    expect(parseFocusUrl('/mutes')).toBeNull();
    expect(parseFocusUrl('/')).toBeNull();
    // btc-price has no FV object — stays classic.
    expect(parseFocusUrl('/addons/btc-price')).toBeNull();
  });

  /**
   * Regression tests for the v1 `scc` query-param strip: shell-written
   * URLs must never carry a stale right-pane tab — a surviving scc
   * re-applied an old tab state on every object switch (the "looping"
   * bug). Other query params survive; paths without a query are untouched.
   */
  it('strips the v1 scc query param (stripSccQueryParam)', () => {
    expect(stripSccQueryParam('/note/nevent1?scc=timeline')).toBe(
      '/note/nevent1'
    );
    expect(stripSccQueryParam('/timeline?scc=x')).toBe('/timeline');
    // Strips only scc, keeps other query params.
    expect(stripSccQueryParam('/media?a=1&scc=x&b=2')).toBe('/media?a=1&b=2');
    expect(stripSccQueryParam('/media?scc=x&a=1')).toBe('/media?a=1');
    // Paths without a query / without scc stay untouched.
    expect(stripSccQueryParam('/timeline')).toBe('/timeline');
    expect(stripSccQueryParam('/marketplace?sort=price')).toBe(
      '/marketplace?sort=price'
    );
  });
});
