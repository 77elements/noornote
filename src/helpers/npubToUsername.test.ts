// @vitest-environment jsdom
/**
 * Regression tests for npubToUsername (html-multi) URL-safety.
 *
 * The mention regexes carry `(?<!\/)` + `(?<![?&=])` lookbehinds (mirroring
 * NOSTR_EVENT_REF_REGEX) so npubs inside linkified URLs — path segments AND
 * query params — are never replaced with mention chips inside the anchor's
 * href or visible link text.
 */

import { describe, it, expect, vi } from 'vitest';

// UserProfileService is a heavy NDK-bound singleton — html-multi mode only
// needs the injected profileResolver.
vi.mock('../services/UserProfileService', () => ({
  UserProfileService: {
    getInstance: () => ({
      getUsername: () => null,
      getUserProfile: vi.fn().mockResolvedValue(null),
    }),
  },
}));

import { npubToUsername } from './npubToUsername';
import { hexToNpub } from './nip19';

const HEX_A = 'a'.repeat(64);
const npub = hexToNpub(HEX_A) as string;
const nullResolver = () => null;

describe('npubToUsername (html-multi)', () => {
  it('keeps npubs inside URL query params untouched', () => {
    const url = `https://example.com/?npub=${npub}`;
    const html = `<a href="${url}" rel="noopener">${url}</a>`;
    expect(npubToUsername(html, 'html-multi', nullResolver)).toBe(html);
  });

  it('keeps npubs inside URL paths untouched', () => {
    const url = `https://primal.net/${npub}`;
    const html = `<a href="${url}" rel="noopener">${url}</a>`;
    expect(npubToUsername(html, 'html-multi', nullResolver)).toBe(html);
  });

  it('still converts a standalone nostr:npub mention', () => {
    const out = npubToUsername(`hi nostr:${npub}`, 'html-multi', nullResolver);
    expect(out).toContain('mention-link');
    expect(out).toContain('data-mention');
  });
});
