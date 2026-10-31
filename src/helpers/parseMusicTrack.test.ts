/**
 * Regression tests for parseMusicTrack / parseMusicPlaylist — the Nostr music
 * kinds (36787 track, 34139 playlist, podtunes/nostria convention). The
 * 2026-11-31 case: a kind-1 note quoting a sunami.app track naddr rendered
 * "Unsupported event kind 36787" because no renderer existed for the kind.
 */

import { describe, it, expect } from 'vitest';
import {
  parseMusicTrack,
  parseMusicPlaylist,
  splitTrackRef,
  MUSIC_TRACK_KIND,
} from './parseMusicTrack';

const AUTHOR =
  'fd2ee25fd0ef442aa1b7404a9354b12e554ec0dead81a6c8bdb8cda2ff09373f';

/** Real-world shape: the podtunes/nostria track from kind-36787 survey. */
const TRACK_EVENT = {
  pubkey: AUTHOR,
  tags: [
    ['d', 'track-1793371918364-43yi9pmfx'],
    ['title', 'Come Back to Me Now'],
    [
      'url',
      'https://phafe.com/wp-content/uploads/strangelove/Album/12comebacktomenow.mp3',
    ],
    ['t', 'music'],
    ['image', 'https://blossom.primal.net/cover.jpg'],
    ['t', 'rock'],
    ['artist', 'Strange Love'],
    ['album', 'Strange Love'],
    ['track_number', '12'],
    ['duration', '187'],
    ['license', 'All Rights Reserved'],
    ['zap', AUTHOR, 'wss://relay.damus.io', '100'],
    ['alt', 'Music track: Come Back to Me Now by Strange Love'],
    ['client', 'nostria'],
  ],
};

describe('parseMusicTrack', () => {
  it('parses the podtunes/nostria track event shape', () => {
    const track = parseMusicTrack(TRACK_EVENT);
    expect(track).not.toBeNull();
    expect(track!.id).toBe('track-1793371918364-43yi9pmfx');
    expect(track!.title).toBe('Come Back to Me Now');
    expect(track!.url).toContain('12comebacktomenow.mp3');
    expect(track!.artist).toBe('Strange Love');
    expect(track!.album).toBe('Strange Love');
    expect(track!.trackNumber).toBe(12);
    expect(track!.durationSec).toBe(187);
    expect(track!.license).toBe('All Rights Reserved');
    expect(track!.zapSplits).toEqual([AUTHOR]);
  });

  it('returns null when the event carries no title/url/d at all', () => {
    expect(
      parseMusicTrack({ pubkey: AUTHOR, tags: [['client', 'x']] })
    ).toBeNull();
  });

  it('tolerates missing optional tags', () => {
    const track = parseMusicTrack({
      pubkey: AUTHOR,
      tags: [
        ['d', 't1'],
        ['title', 'Solo'],
        ['url', 'https://example.com/a.mp3'],
      ],
    });
    expect(track!.artist).toBeUndefined();
    expect(track!.durationSec).toBeUndefined();
    expect(track!.zapSplits).toEqual([]);
  });
});

describe('parseMusicPlaylist', () => {
  it('collects only 36787 a-tag coordinates', () => {
    const playlist = parseMusicPlaylist({
      pubkey: AUTHOR,
      tags: [
        ['d', 'playlist-1771046864429-174fvi3f3'],
        ['title', 'Strange Love (Self-Titled Album)'],
        ['image', 'https://phafe.com/cover.jpg'],
        ['a', `${MUSIC_TRACK_KIND}:${AUTHOR}:track-a`],
        ['a', `30023:${AUTHOR}:article`],
        ['a', `${MUSIC_TRACK_KIND}:${AUTHOR}:track-b`],
        ['t', 'music'],
      ],
    });
    expect(playlist.title).toBe('Strange Love (Self-Titled Album)');
    expect(playlist.trackRefs).toEqual([
      `${MUSIC_TRACK_KIND}:${AUTHOR}:track-a`,
      `${MUSIC_TRACK_KIND}:${AUTHOR}:track-b`,
    ]);
  });

  it('falls back to the d identifier as title', () => {
    const playlist = parseMusicPlaylist({
      pubkey: AUTHOR,
      tags: [['d', 'p1']],
    });
    expect(playlist.title).toBe('p1');
    expect(playlist.trackRefs).toEqual([]);
  });
});

describe('splitTrackRef', () => {
  it('splits a coordinate and rejects malformed refs', () => {
    expect(splitTrackRef(`${MUSIC_TRACK_KIND}:${AUTHOR}:track-a`)).toEqual({
      pubkey: AUTHOR,
      identifier: 'track-a',
    });
    expect(splitTrackRef('36787')).toBeNull();
  });
});
