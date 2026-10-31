/**
 * Tests for the shared music player builder used by all music-ish cards
 * (kind 30003 ZapTrax playlists, kind 36787 tracks, kind 34139 playlists).
 * Wiring is covered by the BookmarkListRenderer jsdom tests.
 */

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  buildMusicPlayerHtml,
  buildMusicTrackRowHtml,
} from './musicPlayerShared';

describe('buildMusicPlayerHtml', () => {
  it('renders the shared audio player and one row per track', () => {
    const html = buildMusicPlayerHtml([
      { ref: 'https://example.com/a.mp3', title: 'A', indexLabel: '1' },
      { ref: 'https://example.com/b.mp3', title: 'B', indexLabel: '2' },
    ]);
    expect(html).toContain('<audio class="bookmark-list__player"');
    expect((html.match(/bookmark-list__track /g) ?? []).length).toBe(2);
    expect(html).toContain('>1</span>');
    expect(html).toContain('>2</span>');
  });

  it('marks only absolute http(s) refs playable', () => {
    const html = buildMusicPlayerHtml([
      { ref: 'https://example.com/a.mp3', title: 'A', indexLabel: '▶' },
      { ref: 'e29ac0e3', title: 'Coord', indexLabel: '2' },
    ]);
    expect(html).toContain('bookmark-list__track--playable');
    expect(html).toContain('data-ref="https://example.com/a.mp3"');
    expect(html).not.toContain(
      'data-ref="e29ac0e3" bookmark-list__track--playable'
    );
  });

  it('escapes the ref attribute value', () => {
    const html = buildMusicTrackRowHtml({
      ref: 'https://example.com/a.mp3"onload="x',
      title: 'A',
      indexLabel: '1',
    });
    expect(html).toContain(
      'data-ref="https://example.com/a.mp3&quot;onload=&quot;x"'
    );
  });

  it('formats the duration and joins artist with an em dash', () => {
    const html = buildMusicTrackRowHtml({
      ref: 'https://example.com/a.mp3',
      title: 'A',
      artist: 'B',
      durationSec: 187,
      indexLabel: '1',
    });
    expect(html).toContain('A — B');
    expect(html).toContain('3:07');
  });

  it('falls back to the ref as label when no title is present', () => {
    const html = buildMusicTrackRowHtml({
      ref: 'https://example.com/a.mp3',
      title: '',
      indexLabel: '1',
    });
    expect(html).toContain('https://example.com/a.mp3');
  });
});
