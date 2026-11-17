import { describe, expect, it } from 'vitest';
import { CANONICAL_APP_ORIGIN, canonicalShareUrl } from './canonicalShareUrl';

describe('canonicalShareUrl', () => {
  it('always points at the production origin, regardless of runtime', () => {
    // Regression: on Electron window.location.origin is file://, on dev
    // localhost — share links went out as file:///note/... and were dead.
    const url = canonicalShareUrl('/note/nevent1abc');
    expect(url.startsWith('https://noornote.app/')).toBe(true);
    expect(url.startsWith('file://')).toBe(false);
    expect(url.startsWith('http://localhost')).toBe(false);
  });

  it('keeps the passed deep-link path intact', () => {
    expect(canonicalShareUrl('/note/nevent1abc')).toBe(
      'https://noornote.app/note/nevent1abc'
    );
    expect(canonicalShareUrl('/article/naddr1xyz')).toBe(
      'https://noornote.app/article/naddr1xyz'
    );
  });

  it('normalizes a missing leading slash', () => {
    expect(canonicalShareUrl('note/nevent1abc')).toBe(
      'https://noornote.app/note/nevent1abc'
    );
  });

  it('exposes the canonical origin as a constant', () => {
    expect(CANONICAL_APP_ORIGIN).toBe('https://noornote.app');
  });
});
