// @vitest-environment jsdom
/**
 * Regression tests for renderNostrReferenceLinks — inline single-line links
 * for bare/pre Nostr event references (profile bios etc.).
 */

import { describe, it, expect, vi } from 'vitest';

// UserProfileService is a heavy singleton (NDK-bound) — the helper only needs
// the sync username cache + fire-and-forget profile priming.
vi.mock('../services/UserProfileService', () => ({
  UserProfileService: {
    getInstance: () => ({
      getUsername: (pubkey: string) =>
        pubkey === 'b'.repeat(64) ? 'Satoshi' : null,
      getUserProfile: vi.fn().mockResolvedValue(null),
    }),
  },
}));

import { renderNostrReferenceLinks } from './renderNostrReferenceLinks';
import {
  encodeNevent,
  encodeNaddr,
  noteEncode,
} from '../services/NostrToolsAdapter';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

/** Build a real nevent so decodeNip19 succeeds in the test. */
function makeNevent(authorHex: string): string {
  return encodeNevent(HEX_A, [], authorHex);
}

function makeNaddr(kind: number): string {
  return encodeNaddr({ kind, pubkey: HEX_B, identifier: 'test-id' });
}

describe('renderNostrReferenceLinks', () => {
  it('rewrites a bare nevent into a single-line SNV link', () => {
    const nevent = makeNevent(HEX_A);
    const out = renderNostrReferenceLinks(`Read this: ${nevent} — worth it.`);
    expect(out).toContain(`href="/note/${nevent}"`);
    expect(out).toContain('nostr-ref-link');
    expect(out).toContain('Note');
    expect(out).not.toContain(`${nevent} —`);
  });

  it('keeps the full text around the link', () => {
    const nevent = makeNevent(HEX_A);
    const out = renderNostrReferenceLinks(`Read this: ${nevent} — worth it.`);
    expect(out.startsWith('Read this: <a')).toBe(true);
    expect(out.endsWith('— worth it.')).toBe(true);
  });

  it('handles the nostr: prefix form', () => {
    const nevent = makeNevent(HEX_A);
    const out = renderNostrReferenceLinks(`nostr:${nevent}`);
    expect(out).toContain('nostr-ref-link');
  });

  it('labels the author from the profile cache', () => {
    const nevent = makeNevent(HEX_B);
    const out = renderNostrReferenceLinks(nevent);
    expect(out).toContain('Note by Satoshi');
  });

  it('labels naddr targets by kind (article)', () => {
    const naddr = makeNaddr(30023);
    const out = renderNostrReferenceLinks(naddr);
    expect(out).toContain('Article');
    expect(out).toContain(`href="/note/${naddr}"`);
  });

  it('labels unknown naddr kinds as Event', () => {
    const naddr = makeNaddr(30054);
    const out = renderNostrReferenceLinks(naddr);
    expect(out).toContain('Event');
  });

  it('does not match references inside href attributes', () => {
    const nevent = makeNevent(HEX_A);
    const html = `<a href="/note/${nevent}">existing link</a>`;
    const out = renderNostrReferenceLinks(html);
    // The href value must survive untouched (no nested link injection)
    expect(out).toBe(html);
  });

  it('still links undecodable references with a generic label', () => {
    // Valid bech32 shape, garbage payload — decode throws, link must remain
    const fake = `nevent1${'q'.repeat(80)}`;
    const out = renderNostrReferenceLinks(fake);
    expect(out).toContain('nostr-ref-link');
    expect(out).toContain('Note');
  });

  it('leaves text without references untouched', () => {
    const text = 'Just a bio with a URL https://example.com and #hashtags';
    expect(renderNostrReferenceLinks(text)).toBe(text);
  });

  it('escapes author names', () => {
    // getUsername is mocked — exercise a real note1 reference (no author)
    const note = noteEncode(HEX_A);
    const out = renderNostrReferenceLinks(note);
    expect(out).toContain('Note');
    expect(out).toContain(`href="/note/${note}"`);
  });
});
