// @vitest-environment jsdom
/**
 * Regression tests for NIP-71 addressable video routing (kind 34235/34236).
 * These events previously fell into the "Unsupported event kind" fallback;
 * they must route to VideoNoteProcessor like their regular counterparts
 * (kind 21/22) and expose the addressable coordinate for ISL/stats.
 */

import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

// The real ContentProcessor pulls in the lists/AutoSync chain (PlatformService,
// SystemLogger singletons) which cannot load in the node test environment.
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

// NoteProcessor transitively imports services that instantiate at module load
// (HighlightProcessor → npubToUsername → UserProfileService →
// ProfileOrchestrator/AuthService → lists chain). Stub them at the boundary.
vi.mock('../../../services/UserProfileService', () => ({
  UserProfileService: {
    getInstance: () => ({ getUsername: () => null }),
  },
}));
vi.mock('../../../services/AuthService', () => ({
  AuthService: {
    getInstance: () => ({ getCurrentUser: () => null }),
  },
}));

import { NoteProcessor } from './NoteProcessor';

function makeVideoEvent(kind: number): NostrEvent {
  return {
    id: 'c'.repeat(64),
    pubkey: 'd'.repeat(64),
    created_at: 1786701173,
    kind,
    tags: [
      ['d', 'my-video'],
      ['title', 'Test Video'],
      [
        'imeta',
        'url https://example.com/video.mp4',
        'm video/mp4',
        'dim 1920x1080',
        'image https://example.com/thumb.jpg',
      ],
    ],
    content: 'A summary of the video',
    sig: 'e'.repeat(128),
  } as unknown as NostrEvent;
}

describe.each([34235, 34236])(
  'NoteProcessor addressable video routing (kind %i)',
  kind => {
    it('routes to the video pipeline (type "original" with video media)', () => {
      const note = NoteProcessor.process(makeVideoEvent(kind));
      expect(note.type).toBe('original');
      expect(note.content.media).toHaveLength(1);
      expect(note.content.media[0]).toMatchObject({
        type: 'video',
        url: 'https://example.com/video.mp4',
        thumbnail: 'https://example.com/thumb.jpg',
      });
    });

    it('prepends title and video placeholder like kind 21/22', () => {
      const note = NoteProcessor.process(makeVideoEvent(kind));
      expect(note.content.html).toContain('video-note-title');
      expect(note.content.html).toContain('Test Video');
      expect(note.content.html).toContain('__MEDIA_0__');
    });
  }
);
