import { describe, expect, it } from 'vitest';
import { parseFocusUrl } from './focusUrlState';

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

  it('maps every addon object list route to its owning domain', () => {
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
  });

  it('maps the addon object param deep links', () => {
    expect(parseFocusUrl('/addons/nostr-majlis/daily-ayah')).toEqual({
      defId: 'majlis',
      kind: 'detail',
      param: 'daily-ayah',
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
});
