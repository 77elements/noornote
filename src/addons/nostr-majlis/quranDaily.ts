/**
 * quranDaily - the daily Quran ayah for the Nostr-Majlis widget and addon tab.
 *
 * Pick: a deterministic hash of the local date (YYYY-M-D) selects one of the
 * 6236 ayahs, resolved to `surah:ayah` through the surah-size table. Everyone
 * sees the same ayah on the same day; the pick rolls over at local midnight.
 *
 * Fetch: three tiny static JSON files on public CDNs (Arabic Uthmani, English
 * translation The Clear Quran, English tafsir Al-Mukhtasar).
 * `Promise.allSettled` — the
 * Arabic text is required; translation and tafsir degrade independently.
 * Results are cached per day in PerAccountLocalStorage; on fetch failure the
 * last cached ayah is served regardless of its date, so the section never goes
 * blank.
 *
 * Sources (see docs/todos/nostr-majlis-quran-daily.md):
 *  - https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/{edition}/{surah}/{ayah}.min.json
 *  - https://cdn.jsdelivr.net/gh/spa5k/tafsir_api@main/tafsir/{edition}/{surah}/{ayah}.json
 */

import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';

/** Number of ayahs per surah, index 0 = surah 1 (Al-Fatihah). */
export const SURAH_AYAH_COUNTS: number[] = [
  7, 286, 200, 176, 120, 165, 206, 75, 129, 109, 123, 111, 43, 52, 99, 128, 111,
  110, 98, 135, 112, 78, 118, 64, 77, 227, 93, 88, 69, 60, 34, 30, 73, 54, 45,
  83, 182, 88, 75, 85, 54, 53, 89, 59, 37, 35, 38, 29, 18, 45, 60, 49, 62, 55,
  78, 96, 29, 22, 24, 13, 14, 11, 11, 18, 12, 12, 30, 52, 52, 44, 28, 28, 20,
  56, 40, 31, 50, 40, 46, 42, 29, 19, 36, 25, 22, 17, 19, 26, 30, 20, 15, 21,
  11, 8, 8, 19, 5, 8, 8, 11, 11, 8, 3, 9, 5, 4, 7, 3, 6, 3, 5, 4, 5, 6,
];

export const TOTAL_AYAHS = SURAH_AYAH_COUNTS.reduce((a, b) => a + b, 0); // 6236

export interface DailyAyah {
  surah: number;
  ayah: number;
  arabic: string;
  english: string | null;
  tafsir: string | null;
}

interface CacheEntry {
  /** Cache shape version — bumped whenever DailyAyah's shape changes. */
  v: 2;
  dateKey: string;
  ayah: DailyAyah;
}

const QURAN_EDITION = 'ara-quranuthmanihaf';
const ENGLISH_EDITION = 'eng-mustafakhattaba'; // The Clear Quran (Mustafa Khattab)
const TAFSIR_EDITION = 'en-tafsir-al-mukhtasar';
const QURAN_BASE = `https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions`;
// Pinned release tag (spa5k README: exact tags are edge-cached immutable;
// @main resolves live and is the flakier choice).
const TAFSIR_BASE = `https://cdn.jsdelivr.net/gh/spa5k/tafsir_api@v1.2.1/tafsir`;

/** Widget display caps — the Daily Ayah tab shows the full texts. */
export const WIDGET_TRANSLATION_MAX = 280;

/** `YYYY-M-D` of the local day — the pick/cache key. */
export function dateKeyOf(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** Deterministic day → ayah index (0-based). Stable across sessions/years. */
export function dailyAyahIndex(date: Date): number {
  const key = dateKeyOf(date);
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % TOTAL_AYAHS;
}

/** Ayah index (1..6236) → surah/ayah numbers via the surah-size table. */
export function indexToSurahAyah(index0: number): {
  surah: number;
  ayah: number;
} {
  let rest = index0;
  for (let s = 0; s < SURAH_AYAH_COUNTS.length; s++) {
    const count = SURAH_AYAH_COUNTS[s]!;
    if (rest < count) return { surah: s + 1, ayah: rest + 1 };
    rest -= count;
  }
  return { surah: 114, ayah: SURAH_AYAH_COUNTS[113]! };
}

/** Truncate for widget display, at char budget, whole-word aware. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function quranUrl(edition: string, surah: number, ayah: number): string {
  return `${QURAN_BASE}/${edition}/${surah}/${ayah}.min.json`;
}

function tafsirUrl(surah: number, ayah: number): string {
  return `${TAFSIR_BASE}/${TAFSIR_EDITION}/${surah}/${ayah}.json`;
}

async function fetchJson(url: string): Promise<unknown> {
  try {
    // A stalled CDN connection must not hold the UI in "Loading…" forever.
    const res = await fetch(url, { signal: AbortSignal.timeout?.(8000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function textOf(value: unknown): string | null {
  const v = value as { text?: unknown } | null;
  return typeof v?.text === 'string' ? v.text : null;
}

function readCache(): CacheEntry | null {
  const entry = PerAccountLocalStorage.getInstance().get<CacheEntry | null>(
    StorageKeys.NOSTR_MAJLIS_QURAN_DAILY_CACHE,
    null
  );
  // Shape-versioned: an entry from an older shape (e.g. pre-English) is a miss.
  return entry?.v === 2 ? entry : null;
}

function writeCache(dateKey: string, ayah: DailyAyah): void {
  PerAccountLocalStorage.getInstance().set<CacheEntry>(
    StorageKeys.NOSTR_MAJLIS_QURAN_DAILY_CACHE,
    { v: 2, dateKey, ayah }
  );
}

// Local day key whose fetch already failed — prevents a retry request every
// 10s widget tick and lets the UI show "unavailable" instead of "Loading…".
// A retry is allowed after the cooldown (transient network hiccups shouldn't
// kill the whole day). Resets on reload and on day change.
let failedKey = '';
let failedAt = 0;
const FAILURE_RETRY_MS = 10 * 60_000;

/**
 * Today's ayah: cache hit for today → serve immediately; else fetch, cache and
 * return; on failure → the last cached ayah (any date); if nothing ever
 * loaded → null (the UI shows an unavailable state, not an eternal spinner).
 */
export async function getDailyAyah(date?: Date): Promise<DailyAyah | null> {
  const now = date ?? new Date();
  const key = dateKeyOf(now);
  const cached = readCache();
  if (cached?.dateKey === key && cached.ayah) return cached.ayah;
  if (failedKey === key && Date.now() - failedAt < FAILURE_RETRY_MS) {
    return cached?.ayah ?? null;
  }

  const { surah, ayah } = indexToSurahAyah(dailyAyahIndex(now));
  const [arabicRes, englishRes, tafsirRes] = await Promise.allSettled([
    fetchJson(quranUrl(QURAN_EDITION, surah, ayah)),
    fetchJson(quranUrl(ENGLISH_EDITION, surah, ayah)),
    fetchJson(tafsirUrl(surah, ayah)),
  ]);

  const arabic =
    arabicRes.status === 'fulfilled' ? textOf(arabicRes.value) : null;
  if (!arabic) {
    failedKey = key;
    failedAt = Date.now();
    return cached?.ayah ?? null;
  }

  const result: DailyAyah = {
    surah,
    ayah,
    arabic,
    english:
      englishRes.status === 'fulfilled' ? textOf(englishRes.value) : null,
    tafsir: tafsirRes.status === 'fulfilled' ? textOf(tafsirRes.value) : null,
  };
  failedKey = '';
  writeCache(key, result);
  return result;
}
