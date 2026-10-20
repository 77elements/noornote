// @vitest-environment jsdom
/**
 * BookmarkListRenderer card tests — NIP-51 kind 30003 (bookmark lists /
 * ZapTrax playlists). Playlist events render title, track count, a shared
 * audio player and track rows; plain bookmark folders render as a summary
 * card without a player.
 */

import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

vi.mock('../NoteHeader', () => ({
  NoteHeader: class {
    getElement(): HTMLElement {
      return document.createElement('div');
    }
    destroy(): void {}
  },
}));

vi.mock('../../../services/ViewNavigationController', () => ({
  getViewNavigationController: () => ({ openView: vi.fn() }),
}));

vi.mock('./packCardShared', () => ({
  appendPackISL: vi.fn(),
}));

import { BookmarkListRenderer } from './BookmarkListRenderer';
import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';

const PUBKEY = 'a'.repeat(64);
const URL_1 = 'https://op3.dev/e/https://cdn.example.com/track/spies.mp3';
const URL_2 = 'https://op3.dev/e/https://cdn.example.com/track/riveters.mp3';

function makeNote(tags: string[][]): ProcessedNote {
  const event = {
    id: '4d70059c1812322aee9c0a1eff75adcee0d74c9de01da221ad24f1bf238622bd',
    pubkey: PUBKEY,
    created_at: 1792385744,
    kind: 30003,
    tags,
    content: '',
    sig: 'c'.repeat(128),
  } as unknown as NostrEvent;
  return {
    id: event.id,
    type: 'bookmark-list',
    timestamp: event.created_at,
    author: { pubkey: event.pubkey },
    content: {
      text: '',
      html: '',
      media: [],
      links: [],
      hashtags: [],
      quotedReferences: [],
      bolt11Invoices: [],
    },
    rawEvent: event,
  };
}

const OPTS: NoteUIOptions = {
  collapsible: false,
  islFetchStats: false,
  isLoggedIn: false,
  headerSize: 'medium',
  depth: 0,
};

const PLAYLIST_TAGS = [
  ['d', 'playlist-1792385360060'],
  ['title', 'DeN+ [electro] selected tracks'],
  ['r', URL_1],
  ['track-title', URL_1, 'Spies in the Night'],
  ['track-artist', URL_1, 'DeN+ [electro]'],
  ['track-duration', URL_1, '281'],
  ['r', URL_2],
  ['track-title', URL_2, 'March of the Riveters'],
  ['track-duration', URL_2, '235'],
];

describe('BookmarkListRenderer — playlist card', () => {
  it('renders title, playlist label, player and track rows', () => {
    const card = BookmarkListRenderer.render(makeNote(PLAYLIST_TAGS), OPTS);

    expect(card.querySelector('h3')?.textContent).toBe(
      'DeN+ [electro] selected tracks'
    );
    expect(card.textContent).toContain('Playlist · 2 tracks');
    expect(card.querySelector('.bookmark-list__player')).not.toBeNull();
    const rows = card.querySelectorAll('.bookmark-list__track--playable');
    expect(rows).toHaveLength(2);
    expect(card.textContent).toContain('Spies in the Night');
    expect(card.textContent).toContain('4:41');
  });

  it('playable track rows carry their ref as data attribute', () => {
    const card = BookmarkListRenderer.render(makeNote(PLAYLIST_TAGS), OPTS);
    const row = card.querySelector<HTMLElement>('.bookmark-list__track');
    expect(row?.dataset.ref).toBe(URL_1);
  });

  it('plain bookmark folders render as a summary card without a player', () => {
    const card = BookmarkListRenderer.render(
      makeNote([
        ['d', 'AI'],
        ['a', '30023:abc:def'],
        ['e', '1'.repeat(64)],
      ]),
      OPTS
    );

    expect(card.querySelector('h3')?.textContent).toBe('AI');
    expect(card.textContent).toContain('Bookmark list · 2 items');
    expect(card.querySelector('.bookmark-list__player')).toBeNull();
  });

  it('non-http track refs are not marked playable', () => {
    const card = BookmarkListRenderer.render(
      makeNote([
        ['d', 'x'],
        ['e', '1'.repeat(64)],
        ['track-title', '1'.repeat(64), 'Just a referenced note'],
      ]),
      OPTS
    );
    expect(
      card.querySelectorAll('.bookmark-list__track--playable')
    ).toHaveLength(0);
  });
});
