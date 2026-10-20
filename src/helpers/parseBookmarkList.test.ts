/**
 * parseBookmarkList tests — NIP-51 kind 30003 (bookmark sets / playlists).
 * Fixtures shaped after real-world events: ZapTrax playlists (r-tag audio
 * URLs + track-* companion tags keyed by the same URL) and plain bookmark
 * folders (e/a references only, NoorNote's own folder shape).
 */

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import {
  parseBookmarkSetEvent,
  formatTrackDuration,
} from './parseBookmarkList';

const PUBKEY = 'a'.repeat(64);

function makeEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: '4d70059c1812322aee9c0a1eff75adcee0d74c9de01da221ad24f1bf238622bd',
    pubkey: PUBKEY,
    created_at: 1792385744,
    kind: 30003,
    tags: [],
    content: '',
    sig: 'c'.repeat(128),
    ...overrides,
  } as NostrEvent;
}

const ZAPTRAX_URL_1 =
  'https://op3.dev/e/https://cdn.example.com/track/spies.mp3';
const ZAPTRAX_URL_2 =
  'https://op3.dev/e/https://cdn.example.com/track/riveters.mp3';

function zaptraxPlaylist(): NostrEvent {
  return makeEvent({
    tags: [
      ['d', 'playlist-1792385360060'],
      ['title', 'DeN+ [electro] selected tracks'],
      ['t', 'music'],
      ['r', ZAPTRAX_URL_1],
      ['track-title', ZAPTRAX_URL_1, 'Spies in the Night'],
      ['track-artist', ZAPTRAX_URL_1, 'DeN+ [electro]'],
      ['track-duration', ZAPTRAX_URL_1, '281'],
      ['track-image', ZAPTRAX_URL_1, 'https://cdn.example.com/cover1.jpg'],
      ['r', ZAPTRAX_URL_2],
      ['track-title', ZAPTRAX_URL_2, 'March of the Riveters'],
      ['track-artist', ZAPTRAX_URL_2, 'DeN+ [electro]'],
      ['track-duration', ZAPTRAX_URL_2, '235'],
      ['client', 'ZapTrax'],
    ],
  });
}

describe('parseBookmarkSetEvent — ZapTrax playlist shape', () => {
  const list = parseBookmarkSetEvent(zaptraxPlaylist());

  it('titles from the title tag, falls back to the d identifier', () => {
    expect(list.title).toBe('DeN+ [electro] selected tracks');
    const noTitle = parseBookmarkSetEvent(
      makeEvent({ tags: [['d', 'playlist-x']] })
    );
    expect(noTitle.title).toBe('playlist-x');
  });

  it('flags playlists via track metadata and counts distinct item refs', () => {
    expect(list.isPlaylist).toBe(true);
    expect(list.itemCount).toBe(2);
  });

  it('extracts track title, artist, duration and image by shared ref', () => {
    expect(list.tracks).toHaveLength(2);
    expect(list.tracks[0]).toMatchObject({
      ref: ZAPTRAX_URL_1,
      title: 'Spies in the Night',
      artist: 'DeN+ [electro]',
      durationSec: 281,
      image: 'https://cdn.example.com/cover1.jpg',
    });
    expect(list.tracks[1].durationSec).toBe(235);
  });

  it('tolerates the plain [name, value] companion shape', () => {
    const list = parseBookmarkSetEvent(
      makeEvent({
        tags: [
          ['d', 'x'],
          ['r', ZAPTRAX_URL_1],
          ['track-title', 'Plain Song'],
        ],
      })
    );
    expect(list.tracks[0]?.title).toBe('Plain Song');
  });
});

describe('parseBookmarkSetEvent — plain bookmark folder shape', () => {
  it('is not a playlist and counts e/a/r references', () => {
    const list = parseBookmarkSetEvent(
      makeEvent({
        tags: [
          ['d', 'AI'],
          ['a', '30023:abc:def'],
          [
            'e',
            '1111111111111111111111111111111111111111111111111111111111111111',
          ],
          [
            'e',
            '2222222222222222222222222222222222222222222222222222222222222222',
          ],
          [
            'e',
            '1111111111111111111111111111111111111111111111111111111111111111',
          ],
        ],
      })
    );
    expect(list.isPlaylist).toBe(false);
    expect(list.itemCount).toBe(3);
    expect(list.tracks).toHaveLength(0);
  });
});

describe('formatTrackDuration', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatTrackDuration(59)).toBe('0:59');
    expect(formatTrackDuration(281)).toBe('4:41');
    expect(formatTrackDuration(4035)).toBe('1:07:15');
  });

  it('returns 0:00 for invalid input', () => {
    expect(formatTrackDuration(Number.NaN)).toBe('0:00');
    expect(formatTrackDuration(-5)).toBe('0:00');
  });
});
