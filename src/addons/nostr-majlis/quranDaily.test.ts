/**
 * Tests for quranDaily pure logic: date-key, the deterministic day→ayah pick,
 * surah:ayah resolution over the surah-size table, and widget truncation.
 * No network / storage — getDailyAyah itself is covered by the live widget.
 */

import { describe, expect, it, vi } from 'vitest';

// Storage is not exercised by these pure-logic tests; mocking it avoids
// pulling the whole PerAccountLocalStorage import chain into the node env.
vi.mock('../../services/PerAccountLocalStorage', () => ({
  PerAccountLocalStorage: {
    getInstance: () => ({ get: () => null, set: () => undefined }),
  },
  StorageKeys: { NOSTR_MAJLIS_QURAN_DAILY_CACHE: 'test_quran_daily_cache' },
}));

import {
  TOTAL_AYAHS,
  SURAH_AYAH_COUNTS,
  dailyAyahIndex,
  dateKeyOf,
  indexToSurahAyah,
  truncateText,
} from './quranDaily';

describe('dateKeyOf', () => {
  it('formats as YYYY-M-D without zero padding', () => {
    expect(dateKeyOf(new Date(2026, 0, 5))).toBe('2026-1-5');
    expect(dateKeyOf(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('differs across days and years', () => {
    expect(dateKeyOf(new Date(2026, 8, 30))).not.toBe(
      dateKeyOf(new Date(2026, 8, 29))
    );
    expect(dateKeyOf(new Date(2026, 8, 30))).not.toBe(
      dateKeyOf(new Date(2027, 8, 30))
    );
  });
});

describe('dailyAyahIndex', () => {
  it('is deterministic for the same day', () => {
    const d = new Date(2026, 8, 30);
    expect(dailyAyahIndex(d)).toBe(dailyAyahIndex(new Date(2026, 8, 30)));
  });

  it('differs across days', () => {
    expect(dailyAyahIndex(new Date(2026, 8, 30))).not.toBe(
      dailyAyahIndex(new Date(2026, 8, 29))
    );
  });

  it('always lands within the ayah range', () => {
    for (let d = 0; d < 366; d++) {
      const idx = dailyAyahIndex(new Date(2026, 0, 1 + d));
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(TOTAL_AYAHS);
    }
  });
});

describe('indexToSurahAyah', () => {
  it('maps the first index to Al-Fatihah 1:1', () => {
    expect(indexToSurahAyah(0)).toEqual({ surah: 1, ayah: 1 });
  });

  it('maps across surah boundaries correctly', () => {
    // Al-Fatihah has 7 ayahs → index 7 = 2:1, index 293 (7+286) = 3:1.
    expect(indexToSurahAyah(7)).toEqual({ surah: 2, ayah: 1 });
    expect(indexToSurahAyah(292)).toEqual({ surah: 2, ayah: 286 });
    expect(indexToSurahAyah(293)).toEqual({ surah: 3, ayah: 1 });
  });

  it('maps the last index to 114:6 (An-Nas)', () => {
    expect(indexToSurahAyah(TOTAL_AYAHS - 1)).toEqual({ surah: 114, ayah: 6 });
  });

  it('covers every ayah exactly once across all surahs', () => {
    const seen = new Set<string>();
    for (let i = 0; i < TOTAL_AYAHS; i++) {
      const { surah, ayah } = indexToSurahAyah(i);
      expect(surah).toBeGreaterThanOrEqual(1);
      expect(surah).toBeLessThanOrEqual(114);
      expect(ayah).toBeGreaterThanOrEqual(1);
      expect(ayah).toBeLessThanOrEqual(SURAH_AYAH_COUNTS[surah - 1]!);
      seen.add(`${surah}:${ayah}`);
    }
    expect(seen.size).toBe(TOTAL_AYAHS);
  });
});

describe('truncateText', () => {
  it('keeps short texts untouched', () => {
    expect(truncateText('short', 10)).toBe('short');
  });

  it('appends an ellipsis at the budget', () => {
    const out = truncateText('a'.repeat(50), 10);
    expect(out.length).toBeLessThanOrEqual(11);
    expect(out.endsWith('…')).toBe(true);
  });
});
