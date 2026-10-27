/**
 * Regression tests for NIP-58 badge definition processing (kind 30009).
 * These events previously fell into the "Unsupported event kind" fallback
 * when quoted/referenced via naddr; they must route to
 * BadgeDefinitionProcessor with self-contained tag data (name/description/
 * image/thumb live in the event's own tags — no async definition fetch).
 */

import { describe, it, expect } from 'vitest';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

import { BadgeDefinitionProcessor } from './BadgeDefinitionProcessor';

function badgeDefinitionEvent(
  overrides: Partial<NostrEvent> = {},
  tags: string[][] = [
    ['d', 'kueken-supporter'],
    ['name', 'Supporter'],
    ['description', 'Affirms responsibility for children.'],
    ['image', 'https://example.com/image.png', '1024x1024'],
    ['thumb', 'https://example.com/thumb.png', '512x512'],
  ]
): NostrEvent {
  return {
    id: 'a'.repeat(64),
    kind: 30009,
    pubkey: 'b'.repeat(64),
    created_at: 1_700_000_000,
    content: '',
    tags,
    sig: 'c'.repeat(128),
    ...overrides,
  } as unknown as NostrEvent;
}

describe('BadgeDefinitionProcessor', () => {
  it('routes kind 30009 to badge-definition with full tag data', () => {
    const note = BadgeDefinitionProcessor.process(badgeDefinitionEvent());

    expect(note.type).toBe('badge-definition');
    expect(note.badgeData?.slug).toBe('kueken-supporter');
    expect(note.badgeData?.name).toBe('Supporter');
    expect(note.badgeData?.description).toBe(
      'Affirms responsibility for children.'
    );
    expect(note.badgeData?.image).toBe('https://example.com/image.png');
    expect(note.badgeData?.thumb).toBe('https://example.com/thumb.png');
  });

  it('builds the addressable coordinate from pubkey + d tag', () => {
    const note = BadgeDefinitionProcessor.process(badgeDefinitionEvent());
    const pubkey = 'b'.repeat(64);

    expect(note.badgeData?.coordinate).toBe(`30009:${pubkey}:kueken-supporter`);
  });

  it('falls back to the d tag as name when the name tag is missing', () => {
    const note = BadgeDefinitionProcessor.process(
      badgeDefinitionEvent({}, [['d', 'my-badge']])
    );

    expect(note.badgeData?.name).toBe('my-badge');
    expect(note.badgeData?.description).toBe('');
  });

  it('leaves image/thumb undefined when the tags are absent', () => {
    const note = BadgeDefinitionProcessor.process(
      badgeDefinitionEvent({}, [
        ['d', 'x'],
        ['name', 'X'],
      ])
    );

    expect(note.badgeData?.image).toBeUndefined();
    expect(note.badgeData?.thumb).toBeUndefined();
  });
});
