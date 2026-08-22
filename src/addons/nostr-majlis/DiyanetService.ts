/**
 * DiyanetService - official Diyanet prayer times at runtime (exact, worldwide).
 *
 * Source: ezanvakti.emushaf.net (Diyanet mirror, CORS-open). Hierarchy
 * Country (Ulke) -> Region (Sehir) -> District (Ilce) -> times (vakitler, rolling ~30 days).
 * The API only serves a rolling window, so fetched days are merged into a PERSISTENT cache
 * (survives reload, works offline until they run out). The "Fetch Prayer Times" button calls
 * fetchAndCacheTimes() to append the next window. See docs/todos/muslims-addon.md.
 */

import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';
import { diagLog } from '../../services/DiagnosticLogger';

const BASE = 'https://ezanvakti.emushaf.net';

export interface DiyanetPlace {
  id: string;
  name: string;
}
export interface DiyanetDayTimes {
  date: string; // dd.mm.yyyy
  fajr: string;
  sunrise: string;
  dhuhr: string;
  asr: string;
  maghrib: string;
  isha: string;
}

interface RawUlke {
  UlkeID: string;
  UlkeAdi: string;
  UlkeAdiEn?: string;
}
interface RawSehir {
  SehirID: string;
  SehirAdi: string;
}
interface RawIlce {
  IlceID: string;
  IlceAdi: string;
}
interface RawVakit {
  MiladiTarihKisa: string;
  Imsak: string;
  Gunes: string;
  Ogle: string;
  Ikindi: string;
  Aksam: string;
  Yatsi: string;
}

function dateKey(ddmmyyyy: string): number {
  const [d, m, y] = ddmmyyyy.split('.');
  return parseInt(`${y}${m}${d}`, 10) || 0;
}

export class DiyanetService {
  private static instance: DiyanetService | null = null;

  static getInstance(): DiyanetService {
    if (!DiyanetService.instance)
      DiyanetService.instance = new DiyanetService();
    return DiyanetService.instance;
  }

  private countries: DiyanetPlace[] | null = null;
  private regions = new Map<string, DiyanetPlace[]>();
  private districts = new Map<string, DiyanetPlace[]>();

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetch(BASE + path, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Diyanet ${path} -> HTTP ${res.status}`);
    return res.json() as Promise<T>;
  }

  async getCountries(): Promise<DiyanetPlace[]> {
    if (this.countries) return this.countries;
    const raw = await this.getJson<RawUlke[]>('/ulkeler');
    this.countries = raw
      .map(u => ({ id: u.UlkeID, name: u.UlkeAdiEn || u.UlkeAdi }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return this.countries;
  }

  async getRegions(ulkeId: string): Promise<DiyanetPlace[]> {
    const cached = this.regions.get(ulkeId);
    if (cached) return cached;
    const raw = await this.getJson<RawSehir[]>(`/sehirler/${ulkeId}`);
    const list = raw
      .map(s => ({ id: s.SehirID, name: s.SehirAdi }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.regions.set(ulkeId, list);
    return list;
  }

  async getDistricts(sehirId: string): Promise<DiyanetPlace[]> {
    const cached = this.districts.get(sehirId);
    if (cached) return cached;
    const raw = await this.getJson<RawIlce[]>(`/ilceler/${sehirId}`);
    const list = raw
      .map(i => ({ id: i.IlceID, name: i.IlceAdi }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.districts.set(sehirId, list);
    return list;
  }

  // ---- persistent times cache (per ilceId) ----

  private readCache(): Record<string, DiyanetDayTimes[]> {
    return PerAccountLocalStorage.getInstance().get<
      Record<string, DiyanetDayTimes[]>
    >(StorageKeys.NOSTR_MAJLIS_DIYANET_CACHE, {});
  }

  private writeCache(map: Record<string, DiyanetDayTimes[]>): void {
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.NOSTR_MAJLIS_DIYANET_CACHE,
      map
    );
  }

  private todayStr(): string {
    const n = new Date();
    return `${String(n.getDate()).padStart(2, '0')}.${String(n.getMonth() + 1).padStart(2, '0')}.${n.getFullYear()}`;
  }

  /** Cached rows for a district (persistent). */
  cachedRows(ilceId: string): DiyanetDayTimes[] {
    return this.readCache()[ilceId] || [];
  }

  /** Today's cached times, or null if not present (ran out / never fetched). */
  cachedToday(ilceId: string): DiyanetDayTimes | null {
    const today = this.todayStr();
    return this.cachedRows(ilceId).find(r => r.date === today) || null;
  }

  /** Fetch the API's current window and merge it into the persistent cache (dedup + sorted). */
  async fetchAndCacheTimes(ilceId: string): Promise<DiyanetDayTimes[]> {
    const raw = await this.getJson<RawVakit[]>(`/vakitler/${ilceId}`);
    const fresh: DiyanetDayTimes[] = raw
      .filter(r => r.Imsak)
      .map(r => ({
        date: r.MiladiTarihKisa,
        fajr: r.Imsak,
        sunrise: r.Gunes,
        dhuhr: r.Ogle,
        asr: r.Ikindi,
        maghrib: r.Aksam,
        isha: r.Yatsi,
      }));

    const cache = this.readCache();
    const byDate = new Map<string, DiyanetDayTimes>();
    for (const row of cache[ilceId] || []) byDate.set(row.date, row);
    for (const row of fresh) byDate.set(row.date, row); // fresh overrides
    const merged = [...byDate.values()].sort(
      (a, b) => dateKey(a.date) - dateKey(b.date)
    );
    cache[ilceId] = merged;
    this.writeCache(cache);
    diagLog('addons', 'nostr-majlis: Diyanet times cached', {
      ilceId,
      fetched: fresh.length,
      total: merged.length,
    });
    return merged;
  }

  destroy(): void {
    this.countries = null;
    this.regions.clear();
    this.districts.clear();
    // persistent times cache is intentionally kept across sessions/account-switch.
    DiyanetService.instance = null;
    diagLog('addons', 'nostr-majlis: DiyanetService destroyed');
  }
}
