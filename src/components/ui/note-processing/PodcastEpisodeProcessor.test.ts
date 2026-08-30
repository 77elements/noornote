// @vitest-environment jsdom
/**
 * Regression tests for PodcastEpisodeProcessor (kind 30054).
 * Covers duration formatting, tag extraction and HTML escaping of
 * author-controlled tag values.
 */

import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

// The real ContentProcessor pulls in the lists/AutoSync chain (PlatformService,
// SystemLogger singletons) which cannot load in the node test environment.
// The processor only uses processContentWithTags() + getNonBlockingProfile().
vi.mock('../../../services/ContentProcessor', () => ({
  ContentProcessor: {
    getInstance: () => ({
      processContentWithTags: (text: string) => ({
        text,
        html: text,
        media: [],
        links: [],
        hashtags: [],
        quotedReferences: [],
        bolt11Invoices: [],
      }),
      getNonBlockingProfile: () => null,
    }),
  },
}));

import { PodcastEpisodeProcessor } from './PodcastEpisodeProcessor';

const EPISODE_TAGS = [
  ['d', 'episode-1786701173853-l2qbwzb9s'],
  ['title', 'Nostr Compass Podcast #32'],
  ['audio', 'https://blossom.primal.net/abc.ogg', 'audio/ogg'],
  ['image', 'https://blossom.primal.net/cover.png'],
  ['duration', '3135'],
  ['episode', '32'],
  ['season', '1'],
  ['alt', 'Podcast episode: Nostr Compass Podcast #32'],
];

function makeEvent(overrides?: Partial<NostrEvent>): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1786701173,
    kind: 30054,
    tags: EPISODE_TAGS as string[][],
    content: 'Show notes with #nostr',
    sig: 'c'.repeat(128),
    ...overrides,
  } as NostrEvent;
}

describe('PodcastEpisodeProcessor.formatDuration', () => {
  it('formats minutes:seconds', () => {
    expect(PodcastEpisodeProcessor.formatDuration(3135)).toBe('52:15');
    expect(PodcastEpisodeProcessor.formatDuration(59)).toBe('0:59');
  });

  it('formats hours:minutes:seconds', () => {
    expect(PodcastEpisodeProcessor.formatDuration(4035)).toBe('1:07:15');
  });

  it('returns empty string for invalid input', () => {
    expect(PodcastEpisodeProcessor.formatDuration(NaN)).toBe('');
    expect(PodcastEpisodeProcessor.formatDuration(-5)).toBe('');
  });
});

describe('PodcastEpisodeProcessor.process', () => {
  it('routes to the podcast-episode type', () => {
    const note = PodcastEpisodeProcessor.process(makeEvent());
    expect(note.type).toBe('podcast-episode');
  });

  it('prepends the episode block with title, player and cover', () => {
    const html = PodcastEpisodeProcessor.process(makeEvent()).content.html;
    expect(html).toContain('<h3>Nostr Compass Podcast #32</h3>');
    expect(html).toContain('<audio');
    expect(html).toContain('https://blossom.primal.net/abc.ogg');
    expect(html).toContain('blossom.primal.net/cover.png');
  });

  it('renders the duration badge and numbering', () => {
    const html = PodcastEpisodeProcessor.process(makeEvent()).content.html;
    expect(html).toContain('52:15');
    expect(html).toContain('Episode 32');
    expect(html).toContain('Season 1');
  });

  it('follows with the shownotes content', () => {
    const note = PodcastEpisodeProcessor.process(makeEvent());
    const episodeEnd = note.content.html.indexOf('</div>', 0);
    const shownotes = note.content.html.slice(episodeEnd);
    expect(shownotes).toContain('Show notes with #nostr');
  });

  it('escapes malicious title values', () => {
    const event = makeEvent({
      tags: [['title', '<script>alert(1)</script>']] as string[][],
    });
    const html = PodcastEpisodeProcessor.process(event).content.html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('omits the player when the audio URL is unsafe', () => {
    const event = makeEvent({
      tags: [['audio', 'javascript:alert(1)']] as string[][],
    });
    const html = PodcastEpisodeProcessor.process(event).content.html;
    expect(html).not.toContain('<audio');
  });

  it('falls back to a placeholder cover without image tag', () => {
    const event = makeEvent();
    event.tags = event.tags.filter(t => t[0] !== 'image');
    const html = PodcastEpisodeProcessor.process(event).content.html;
    expect(html).toContain('podcast-episode__cover--placeholder');
  });

  it('omits meta when no duration and no numbering', () => {
    const event = makeEvent();
    event.tags = event.tags.filter(
      t => !['duration', 'episode', 'season'].includes(t[0] ?? '')
    );
    const html = PodcastEpisodeProcessor.process(event).content.html;
    expect(html).not.toContain('podcast-episode__meta');
  });
});
