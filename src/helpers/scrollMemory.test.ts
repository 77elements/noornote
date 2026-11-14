/**
 * Session scroll memory for SingleNoteView (per-note offsets, capped map).
 * Pure logic — the DOM glue (scroll listener, double-rAF restore) lives in
 * the view.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveScrollPosition,
  getScrollPosition,
  clearScrollPosition,
} from './scrollMemory';

describe('scrollMemory', () => {
  beforeEach(() => {
    clearScrollPosition();
  });

  it('saves and returns the last offset per note id', () => {
    saveScrollPosition('note-a', 420);
    expect(getScrollPosition('note-a')).toBe(420);

    saveScrollPosition('note-a', 1337);
    expect(getScrollPosition('note-a')).toBe(1337);
  });

  it('keeps entries independent per note id', () => {
    saveScrollPosition('note-a', 100);
    saveScrollPosition('note-b', 200);
    expect(getScrollPosition('note-a')).toBe(100);
    expect(getScrollPosition('note-b')).toBe(200);
  });

  it('returns undefined for unknown ids', () => {
    expect(getScrollPosition('nope')).toBeUndefined();
  });

  it('evicts the oldest entry beyond the 50-entry cap', () => {
    for (let i = 0; i < 50; i++) {
      saveScrollPosition(`note-${i}`, i * 10);
    }
    saveScrollPosition('note-50', 5000);

    // Oldest (note-0) evicted, everything else still present.
    expect(getScrollPosition('note-0')).toBeUndefined();
    expect(getScrollPosition('note-1')).toBe(10);
    expect(getScrollPosition('note-50')).toBe(5000);
  });

  it('re-saving an existing entry refreshes recency (no wrongful eviction)', () => {
    for (let i = 0; i < 50; i++) {
      saveScrollPosition(`note-${i}`, i * 10);
    }
    // Touch the oldest entry — it must survive the next save.
    saveScrollPosition('note-0', 999);
    saveScrollPosition('note-50', 5000);

    expect(getScrollPosition('note-0')).toBe(999);
    expect(getScrollPosition('note-1')).toBeUndefined();
  });

  it('clearScrollPosition forgets one note without touching others', () => {
    saveScrollPosition('note-a', 1);
    saveScrollPosition('note-b', 2);
    clearScrollPosition('note-a');
    expect(getScrollPosition('note-a')).toBeUndefined();
    expect(getScrollPosition('note-b')).toBe(2);
  });

  it('ignores empty note ids', () => {
    saveScrollPosition('', 100);
    expect(getScrollPosition('')).toBeUndefined();
  });
});
